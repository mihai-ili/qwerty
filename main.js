function esc(text) {
  const div = document.createElement("div");
  div.textContent = String(text ?? "");
  return div.innerHTML;
}

function getQueryParam(name) {
  const url = new URL(location.href);
  return url.searchParams.get(name);
}

function getConfig() {
  const cfg = window.FILMISH_CONFIG;
  if (!cfg || typeof cfg !== "object") return null;
  const supabaseUrl = String(cfg.supabaseUrl || "").trim();
  const supabaseAnonKey = String(cfg.supabaseAnonKey || "").trim();
  const adminEmails = Array.isArray(cfg.adminEmails)
    ? cfg.adminEmails.map((x) => String(x || "").trim().toLowerCase()).filter(Boolean)
    : [];
  if (!supabaseUrl || !supabaseAnonKey) return null;
  return { supabaseUrl, supabaseAnonKey, adminEmails };
}

function sb() {
  const cfg = getConfig();
  if (!cfg) throw new Error("Supabase не настроен: заполните config.js");
  if (!window.supabase?.createClient) throw new Error("Supabase SDK не загрузился");
  return window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
}

async function getAuth() {
  const client = sb();
  const { data } = await client.auth.getUser();
  const user = data?.user || null;
  const cfg = getConfig();
  const email = String(user?.email || "").toLowerCase();
  const isAdmin = !!email && !!cfg?.adminEmails?.includes(email);
  return { client, user, isAdmin };
}

async function renderNav() {
  const nav = document.querySelector("[data-nav]");
  if (!nav) return;

  try {
    const { client, user, isAdmin } = await getAuth();
    nav.innerHTML = `
      <a href="index.html">Главная</a>
      ${isAdmin ? `<a href="admin.html">Админ</a>` : ""}
      ${
        user
          ? `<span>Привет, ${esc(user.email || "пользователь")}</span><a href="#" data-logout>Выход</a>`
          : `<a href="login.html">Вход</a><a class="nav-primary" href="register.html">Регистрация</a>`
      }
    `;
    const logout = nav.querySelector("[data-logout]");
    if (logout) {
      logout.addEventListener("click", async (e) => {
        e.preventDefault();
        await client.auth.signOut();
        location.href = "index.html";
      });
    }
  } catch (e) {
    nav.innerHTML = `
      <a href="index.html">Главная</a>
      <a href="login.html">Вход</a>
      <a class="nav-primary" href="register.html">Регистрация</a>
    `;
    console.warn(e);
  }
}

function mapMovieRow(r) {
  return {
    id: Number(r.id),
    type: r.type === "series" ? "series" : "movie",
    name: String(r.name || ""),
    rating: Number(r.rating || 0),
    smalldescription: String(r.smalldescription || ""),
    description: String(r.description || ""),
    photo: String(r.photo_url || "")
  };
}

async function listMovies() {
  const client = sb();
  const res = await client.from("movies").select("*").order("id", { ascending: false });
  if (res.error) throw res.error;
  return res.data.map(mapMovieRow);
}

async function getMovie(id) {
  const client = sb();
  const res = await client.from("movies").select("*").eq("id", id).maybeSingle();
  if (res.error) throw res.error;
  return res.data ? mapMovieRow(res.data) : null;
}

async function upsertMovie(movie, file) {
  const client = sb();
  const payload = {
    type: movie.type === "series" ? "series" : "movie",
    name: movie.name,
    rating: movie.rating,
    smalldescription: movie.smalldescription,
    description: movie.description
  };

  let row = null;
  if (movie.id) {
    const upd = await client.from("movies").update(payload).eq("id", movie.id).select("*").single();
    if (upd.error) throw upd.error;
    row = upd.data;
  } else {
    const ins = await client.from("movies").insert(payload).select("*").single();
    if (ins.error) throw ins.error;
    row = ins.data;
  }

  if (file && file instanceof File && file.size > 0) {
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const safeExt = ["jpg", "jpeg", "png", "gif", "webp"].includes(ext) ? ext : "jpg";
    const path = `movie_${row.id}/${Date.now()}_${Math.random().toString(16).slice(2)}.${safeExt}`;
    const up = await client.storage.from("posters").upload(path, file, { upsert: true, contentType: file.type || undefined });
    if (up.error) throw up.error;
    const pub = client.storage.from("posters").getPublicUrl(path);
    const photo_url = String(pub.data?.publicUrl || "");
    const upd2 = await client.from("movies").update({ photo_url }).eq("id", row.id).select("*").single();
    if (upd2.error) throw upd2.error;
    row = upd2.data;
  }

  return mapMovieRow(row);
}

async function deleteMovie(id) {
  const client = sb();
  const del = await client.from("movies").delete().eq("id", id);
  if (del.error) throw del.error;
}

async function listReviews(movieId) {
  const client = sb();
  const res = await client
    .from("reviews")
    .select("id,movie_id,user_id,rating,text,created_at")
    .eq("movie_id", movieId)
    .order("created_at", { ascending: false });
  if (res.error) throw res.error;

  const userIds = Array.from(new Set(res.data.map((r) => r.user_id)));
  let profiles = [];
  if (userIds.length) {
    const p = await client.from("profiles").select("user_id,fio").in("user_id", userIds);
    if (!p.error) profiles = p.data || [];
  }
  const fioById = new Map(profiles.map((p) => [p.user_id, p.fio]));

  return res.data.map((r) => ({
    id: r.id,
    rating: Number(r.rating),
    text: String(r.text || ""),
    fio: String(fioById.get(r.user_id) || "Пользователь")
  }));
}

async function addReview(movieId, rating, text) {
  const { client, user } = await getAuth();
  if (!user) throw new Error("Нужно войти");
  const ins = await client.from("reviews").insert({ movie_id: movieId, user_id: user.id, rating, text });
  if (ins.error) throw ins.error;
}

function renderMoviesGrid(grid, movies) {
  grid.innerHTML = movies
    .map((m) => {
      const badge = m.type === "series" ? "Сериал" : "Фильм";
      const img = m.photo ? `<img class="card-thumb" src="${esc(m.photo)}" alt="${esc(m.name)}" />` : "";
      return `
        <a class="card" href="film.html?id=${encodeURIComponent(m.id)}">
          ${img}
          <div class="card-title-row">
            <h3 class="card-title">${esc(m.name)}</h3>
            <span class="badge-type">${badge}</span>
          </div>
          <div class="card-rating"><span>★</span><span>${esc(m.rating)}</span></div>
          <p class="card-desc">${esc(m.smalldescription)}</p>
        </a>
      `;
    })
    .join("");
}

async function renderIndex() {
  const grid = document.querySelector("[data-grid]");
  if (!grid) return;
  const movies = await listMovies();
  renderMoviesGrid(grid, movies);

  const sMovies = document.querySelector("[data-stat-movies]");
  if (sMovies) sMovies.textContent = String(movies.length);

  const sReviews = document.querySelector("[data-stat-reviews]");
  if (sReviews) {
    const client = sb();
    const c = await client.from("reviews").select("*", { count: "exact", head: true });
    sReviews.textContent = String(c.count ?? 0);
  }
}

async function renderFilm() {
  const root = document.querySelector("[data-film]");
  if (!root) return;

  const id = Number(getQueryParam("id"));
  if (!Number.isFinite(id) || id <= 0) {
    root.innerHTML = `<section class="panel"><p class="empty">Фильм не найден.</p></section>`;
    return;
  }

  const movie = await getMovie(id);
  if (!movie) {
    root.innerHTML = `<section class="panel"><p class="empty">Фильм не найден.</p></section>`;
    return;
  }

  const badge = movie.type === "series" ? "Сериал" : "Фильм";
  const poster = movie.photo ? `<img class="detail-poster" src="${esc(movie.photo)}" alt="${esc(movie.name)}" />` : "";
  const reviews = await listReviews(id);

  let canReview = false;
  try {
    const auth = await getAuth();
    canReview = !!auth.user;
  } catch {
    canReview = false;
  }

  const reviewsHtml = reviews.length
    ? reviews
        .map((r) => {
          return `
            <div class="review-item">
              <div class="review-meta">
                <span>${esc(r.fio)}</span>
                <span>★ ${esc(r.rating)}</span>
              </div>
              <div class="review-text">${esc(r.text)}</div>
            </div>
          `;
        })
        .join("")
    : `<p class="empty">Пока нет ни одного отзыва. Будьте первым!</p>`;

  const formHtml = canReview
    ? `
      <form class="form" data-review-form>
        <div>
          <label for="rating">Ваша оценка (0–10)</label>
          <input id="rating" name="rating" type="number" min="0" max="10" step="0.5" required />
        </div>
        <div>
          <label for="text">Ваш отзыв</label>
          <textarea id="text" name="text" required placeholder="Поделитесь впечатлением"></textarea>
        </div>
        <button class="btn btn-primary" type="submit">Оставить отзыв</button>
        <p class="form-error" data-form-error hidden></p>
      </form>
    `
    : `
      <p class="empty">
        Чтобы оставить отзыв, нужно <a href="login.html">войти</a> или
        <a href="register.html">зарегистрироваться</a>.
      </p>
    `;

  root.innerHTML = `
    <section class="panel">
      <div class="detail-layout">
        <div>
          <h1 class="detail-title">${esc(movie.name)}</h1>
          <div class="detail-meta"><strong>${badge}</strong> • <strong>Рейтинг:</strong> ★ ${esc(movie.rating)}</div>
          ${poster ? `<div style="margin:0 0 14px;">${poster}</div>` : ""}
          <p class="detail-text">${esc(movie.description).replace(/\n/g, "<br/>")}</p>
        </div>
        <div>
          <div class="reviews">
            <h3>Отзывы зрителей</h3>
            ${reviewsHtml}
            ${formHtml}
          </div>
        </div>
      </div>
    </section>
  `;

  const form = root.querySelector("[data-review-form]");
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = form.querySelector("[data-form-error]");
      if (err) err.hidden = true;

      const fd = new FormData(form);
      const rating = Number(String(fd.get("rating") || "").replace(",", "."));
      const text = String(fd.get("text") || "").trim();
      if (!Number.isFinite(rating) || rating < 0 || rating > 10 || !text) {
        if (err) {
          err.textContent = "Проверьте оценку (0–10) и текст отзыва.";
          err.hidden = false;
        }
        return;
      }

      try {
        await addReview(id, rating, text);
        await renderFilm();
      } catch (e2) {
        if (err) {
          err.textContent = "Не удалось отправить отзыв. Проверьте вход и попробуйте ещё раз.";
          err.hidden = false;
        }
        console.warn(e2);
      }
    });
  }
}

async function renderLogin() {
  const form = document.querySelector("[data-login-form]");
  if (!form) return;
  const err = document.querySelector("[data-error]");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (err) err.textContent = "";

    const fd = new FormData(form);
    const email = String(fd.get("email") || "").trim().toLowerCase();
    const password = String(fd.get("password") || "");

    try {
      const client = sb();
      const res = await client.auth.signInWithPassword({ email, password });
      if (res.error) throw res.error;
      location.href = "index.html";
    } catch (e2) {
      if (err) err.textContent = "Неверный e-mail или пароль.";
      console.warn(e2);
    }
  });
}

async function renderRegister() {
  const form = document.querySelector("[data-register-form]");
  if (!form) return;
  const err = document.querySelector("[data-error]");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (err) err.textContent = "";

    const fd = new FormData(form);
    const fio = String(fd.get("fio") || "").trim();
    const email = String(fd.get("email") || "").trim().toLowerCase();
    const password = String(fd.get("password") || "");

    if (!fio || !email || !password) {
      if (err) err.textContent = "Заполните все поля.";
      return;
    }

    try {
      const client = sb();
      const res = await client.auth.signUp({ email, password });
      if (res.error) throw res.error;
      const user = res.data?.user;
      if (user) {
        await client.from("profiles").upsert({ user_id: user.id, fio });
      }
      location.href = "index.html";
    } catch (e2) {
      if (err) err.textContent = "Не удалось зарегистрироваться. Проверьте e-mail и пароль.";
      console.warn(e2);
    }
  });
}

function renderAdminListItem(m) {
  const badge = m.type === "series" ? "Сериал" : "Фильм";
  const thumb = m.photo
    ? `<img src="${esc(m.photo)}" alt="${esc(m.name)}" style="width:56px; height:78px; object-fit:cover; border-radius:12px; border:1px solid rgba(255,255,255,0.12);" />`
    : `<div style="width:56px; height:78px; border-radius:12px; border:1px dashed rgba(255,255,255,0.18); opacity:.8;"></div>`;
  return `
    <div style="display:flex; gap:12px; align-items:flex-start; padding:12px; border-radius:16px; border:1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.02);">
      ${thumb}
      <div style="flex:1;">
        <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
          <strong>${esc(m.name)}</strong>
          <span class="badge-type">${badge}</span>
          <span style="opacity:.85;">★ ${esc(m.rating)}</span>
          <span style="opacity:.6;">ID: ${esc(m.id)}</span>
        </div>
        <div style="opacity:.8; margin-top:6px;">${esc(m.smalldescription)}</div>
        <div style="display:flex; gap:10px; margin-top:10px; flex-wrap:wrap;">
          <button class="btn btn-ghost" type="button" data-admin-edit="${esc(m.id)}">Редактировать</button>
          <a class="btn btn-ghost" href="film.html?id=${encodeURIComponent(m.id)}">Открыть</a>
          <button class="btn btn-ghost" type="button" data-admin-delete="${esc(m.id)}">Удалить</button>
        </div>
      </div>
    </div>
  `;
}

async function renderAdmin() {
  const root = document.querySelector("[data-admin]");
  if (!root) return;

  const form = document.querySelector("[data-admin-form]");
  const listRoot = document.querySelector("[data-admin-list]");
  const cancelBtn = document.querySelector("[data-admin-cancel]");
  const saveBtn = document.querySelector("[data-admin-save]");
  const importBtn = document.querySelector("[data-admin-import]");
  const err = document.querySelector("[data-error]");
  const ok = document.querySelector("[data-ok]");

  if (!form || !listRoot || !cancelBtn || !saveBtn || !importBtn) return;

  const auth = await getAuth();
  if (!auth.user) {
    location.href = "login.html";
    return;
  }
  if (!auth.isAdmin) {
    location.href = "index.html";
    return;
  }

  let editingId = null;

  function setEditing(movie) {
    editingId = movie ? Number(movie.id) : null;
    form.type.value = movie?.type || "movie";
    form.name.value = movie?.name || "";
    form.smalldescription.value = movie?.smalldescription || "";
    form.description.value = movie?.description || "";
    form.rating.value = movie?.rating ?? "";
    form.movieId.value = editingId ? String(editingId) : "";
    cancelBtn.hidden = !editingId;
    saveBtn.textContent = editingId ? "Сохранить" : "Создать";
    form.photo.value = "";
  }

  async function reloadList() {
    const movies = await listMovies();
    if (!movies.length) {
      listRoot.className = "empty";
      listRoot.innerHTML = "Пока нет ни одной карточки.";
      return;
    }
    listRoot.className = "";
    listRoot.innerHTML = `<div style="display:grid; gap:10px;">${movies.map(renderAdminListItem).join("")}</div>`;
  }

  cancelBtn.addEventListener("click", () => setEditing(null));

  listRoot.addEventListener("click", async (e) => {
    const btnEdit = e.target.closest?.("[data-admin-edit]");
    const btnDel = e.target.closest?.("[data-admin-delete]");
    if (btnEdit) {
      const id = Number(btnEdit.getAttribute("data-admin-edit") || "");
      const movie = await getMovie(id);
      if (movie) setEditing(movie);
      return;
    }
    if (btnDel) {
      const id = Number(btnDel.getAttribute("data-admin-delete") || "");
      if (!confirm("Удалить карточку навсегда?")) return;
      try {
        await deleteMovie(id);
        if (ok) ok.textContent = "Карточка удалена.";
        if (err) err.textContent = "";
        if (editingId === id) setEditing(null);
        await reloadList();
      } catch (e2) {
        if (err) err.textContent = "Не удалось удалить карточку.";
        if (ok) ok.textContent = "";
        console.warn(e2);
      }
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (err) err.textContent = "";
    if (ok) ok.textContent = "";

    const fd = new FormData(form);
    const type = String(fd.get("type") || "movie");
    const name = String(fd.get("name") || "").trim();
    const smalldescription = String(fd.get("smalldescription") || "").trim();
    const description = String(fd.get("description") || "").trim();
    const rating = Number(String(fd.get("rating") || "").replace(",", "."));
    const movieId = Number(String(fd.get("movieId") || "").trim() || "0");
    const file = fd.get("photo");

    if (!name || !smalldescription || !description || !Number.isFinite(rating) || rating < 0 || rating > 10) {
      if (err) err.textContent = "Проверьте поля и рейтинг (0–10).";
      return;
    }

    try {
      await upsertMovie(
        {
          id: movieId > 0 ? movieId : undefined,
          type: type === "series" ? "series" : "movie",
          name,
          rating: Number(rating.toFixed(1)),
          smalldescription,
          description
        },
        file
      );
      setEditing(null);
      if (ok) ok.textContent = movieId > 0 ? "Карточка обновлена." : "Карточка создана.";
      await reloadList();
    } catch (e2) {
      if (err) err.textContent = "Не удалось сохранить. Проверьте настройки Supabase и права (RLS).";
      console.warn(e2);
    }
  });

  importBtn.addEventListener("click", async () => {
    if (!confirm("Импортировать фильмы из data/movies.json? (добавит новые строки)")) return;
    if (err) err.textContent = "";
    if (ok) ok.textContent = "";
    try {
      const res = await fetch("./data/movies.json", { cache: "no-store" });
      if (!res.ok) throw new Error("Не удалось загрузить data/movies.json");
      const json = await res.json();
      if (!Array.isArray(json)) throw new Error("Некорректный JSON");
      let added = 0;
      for (const m of json) {
        const name = String(m?.name || "").trim();
        const smalldescription = String(m?.smalldescription || "").trim();
        const description = String(m?.description || "").trim();
        const rating = Number(String(m?.rating ?? "0").replace(",", "."));
        const type = String(m?.type || "movie") === "series" ? "series" : "movie";
        if (!name || !smalldescription || !description) continue;
        await upsertMovie(
          { type, name, rating: Number.isFinite(rating) ? rating : 0, smalldescription, description },
          null
        );
        added++;
      }
      if (ok) ok.textContent = `Импорт завершён. Добавлено: ${added}`;
      await reloadList();
    } catch (e2) {
      if (err) err.textContent = "Импорт не удался. Проверьте, что data/movies.json доступен по HTTP.";
      console.warn(e2);
    }
  });

  setEditing(null);
  await reloadList();
}

async function init() {
  await renderNav();
  await renderIndex();
  await renderFilm();
  await renderLogin();
  await renderRegister();
  await renderAdmin();

  const year = document.querySelector("[data-year]");
  if (year) year.textContent = String(new Date().getFullYear());
}

init();

