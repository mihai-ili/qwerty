# ФильмиЩЕ (без PHP) — чтобы работало у всех

Это **статический сайт** (HTML/CSS/JS). Данные хранятся в **Supabase**:

- карточки (таблица `movies`)
- отзывы (таблица `reviews`)
- имена пользователей (таблица `profiles`)
- постеры (Storage bucket `posters`)

Так изменения админа будут **видны всем** на любых ПК.

## Быстрый старт

1) Создайте проект в Supabase.

2) В Supabase откройте **SQL Editor** и выполните SQL ниже.

3) Заполните `config.js`:

- `supabaseUrl`
- `supabaseAnonKey`
- `adminEmails` (список email админов)

4) Загрузите на хостинг файлы:

- `index.html`, `film.html`, `admin.html`, `login.html`, `register.html`
- `main.js`, `styles.css`, `config.js`
- `data/movies.json` (не обязательно, но полезно для кнопки импорта в админке)

## SQL (таблицы + политики)

```sql
create extension if not exists pgcrypto;

create table if not exists public.movies (
  id bigserial primary key,
  type text not null default 'movie' check (type in ('movie','series')),
  name text not null,
  rating numeric not null default 0,
  smalldescription text not null,
  description text not null,
  photo_url text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_movies_updated_at on public.movies;
create trigger trg_movies_updated_at
before update on public.movies
for each row execute procedure public.set_updated_at();

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  fio text not null default ''
);

create table if not exists public.reviews (
  id bigserial primary key,
  movie_id bigint not null references public.movies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  rating numeric not null,
  text text not null,
  created_at timestamptz not null default now()
);

alter table public.movies enable row level security;
alter table public.reviews enable row level security;
alter table public.profiles enable row level security;

create policy "movies: public read"
on public.movies for select
to anon, authenticated
using (true);

create policy "reviews: public read"
on public.reviews for select
to anon, authenticated
using (true);

create policy "movies: auth write"
on public.movies for insert
to authenticated
with check (true);

create policy "movies: auth update"
on public.movies for update
to authenticated
using (true)
with check (true);

create policy "movies: auth delete"
on public.movies for delete
to authenticated
using (true);

create policy "reviews: auth insert"
on public.reviews for insert
to authenticated
with check (true);

create policy "profiles: read own"
on public.profiles for select
to authenticated
using (auth.uid() = user_id);

create policy "profiles: upsert own"
on public.profiles for insert
to authenticated
with check (auth.uid() = user_id);

create policy "profiles: update own"
on public.profiles for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

insert into storage.buckets (id, name, public)
values ('posters', 'posters', true)
on conflict (id) do update set public = true;

create policy "posters: public read"
on storage.objects for select
to anon, authenticated
using (bucket_id = 'posters');

create policy "posters: auth write"
on storage.objects for insert
to authenticated
with check (bucket_id = 'posters');

create policy "posters: auth update"
on storage.objects for update
to authenticated
using (bucket_id = 'posters')
with check (bucket_id = 'posters');

create policy "posters: auth delete"
on storage.objects for delete
to authenticated
using (bucket_id = 'posters');
```


