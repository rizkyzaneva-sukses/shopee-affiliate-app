# Shopee Affiliate Manager (All-in-One)

Dashboard monitoring & manajemen afiliator Shopee (AMS) multi-toko.  
**Dark mode profesional + aksen orange.** Siap deploy di **EasyPanel** + **PostgreSQL**.

---

## Fitur

- Multi toko (token per shop disimpan di PostgreSQL)
- KPI: GMV, Order, Komisi, ROI, Klik, Afiliator Aktif
- Ranking Top 5 + tabel lengkap + search + filter channel
- Campaign list
- Sync manual per toko → tarik data dari Shopee AMS API
- Mode **mock** (langsung jalan tanpa API) & **live**
- Frontend + Backend 1 service

---

## Deploy di EasyPanel

### 1. Buat Database PostgreSQL
- Service → **PostgreSQL**
- Catat: host, port, user, password, database name
- Setelah jalan, jalankan schema:
  - Buka **Terminal** service Postgres atau pakai adminer
  - Copy-paste isi file `database/schema.sql`

### 2. Buat App (Node.js)
- **App** → Source: upload zip / Git / Docker
- Build method: **Dockerfile** (ada di root)
- Port: **3000**
- Environment variables:

```
NODE_ENV=production
PORT=3000
APP_MODE=mock

# Wajib di production — tanpa ini semua endpoint /api dibalas 503
ADMIN_TOKEN=hasil_dari_openssl_rand_hex_32

DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DBNAME

SHOPEE_PARTNER_ID=200xxxx
SHOPEE_PARTNER_KEY=your_key
SHOPEE_REGION=ID
SHOPEE_BASE_URL=https://partner.shopeemobile.com
SHOPEE_REDIRECT_URI=https://domain-anda.com/api/auth/callback
```

- Link ke service PostgreSQL (EasyPanel biasanya otomatis isi `DATABASE_URL`)

### 3. Init Schema
Setelah container app & postgres running:

```bash
# Di terminal app container
node src/db-init.js
```

Atau jalankan SQL manual dari `database/schema.sql`.

### 4. Buka domain
EasyPanel → Domain → point ke app port 3000.

---

## Local Development

```bash
# 1. Postgres (atau pakai docker-compose)
docker compose up -d postgres

# 2. Env
cp .env.example .env
# edit DATABASE_URL dll

# 3. Backend
cd backend
npm install
npm run db:init
npm start

# Buka http://localhost:3000
```

Atau full docker:

```bash
docker compose up --build
```

---

## Alur Integrasi API Real

> **Penting:** Shopee Open Platform tidak memakai login username/password akun
> Shopee. Anda perlu mendaftarkan sebuah *app*, lalu setiap toko memberi
> otorisasi ke app tersebut.

### 1. Daftar App di [Shopee Open Platform](https://open.shopee.com/)

Setelah app disetujui Anda mendapat **Partner ID** dan **Partner Key**.
Di console, daftarkan juga **Redirect URL** — harus sama persis dengan
`SHOPEE_REDIRECT_URI`, termasuk `http`/`https` dan trailing slash.

### 2. Isi environment

```
APP_MODE=live
SHOPEE_PARTNER_ID=...
SHOPEE_PARTNER_KEY=...
SHOPEE_REDIRECT_URI=https://domain-anda.com/api/auth/callback
ADMIN_TOKEN=...
```

### 3. Hubungkan toko

Buka dashboard → tab **Toko Saya** → **Hubungkan Toko**.

Alurnya:

```
Frontend ──GET /api/auth/url──► Backend
                                  │ build & sign auth_partner URL (berlaku 5 menit)
         ◄────── { url } ─────────┘
         │
         └─► Seller login & approve di halaman Shopee
                        │
                        └─► redirect ke /api/auth/callback?code=...&shop_id=...
                                          │ POST /api/v2/auth/token/get
                                          │ simpan access_token + refresh_token ke DB
                                          └─► redirect balik ke dashboard
```

Token otomatis di-refresh (`/api/v2/auth/access_token/get`) 30 menit sebelum
kedaluwarsa, jadi tidak perlu otorisasi ulang selama refresh token masih hidup.

`POST /api/shops` tetap tersedia untuk memasukkan token secara manual bila Anda
sudah punya dari sumber lain.

### 4. Sync

Klik **Sync** di halaman Toko Saya → data afiliator masuk DB & muncul di dashboard.

> ⚠️ **Endpoint AMS belum terverifikasi.** `/api/v2/ams/get_affiliate_performance`
> dan `/api/v2/ams/get_managed_affiliate_list` di [`services/shopee.js`](backend/src/services/shopee.js)
> tidak dapat dikonfirmasi keberadaannya di dokumentasi Shopee Open Platform v2.
> Cocokkan dulu path dan nama field-nya dengan dokumentasi yang Anda terima saat
> app disetujui. Perlu diketahui bahwa **Shopee Affiliate Open API** (sisi
> creator) adalah platform yang berbeda: GraphQL di host
> `open-api.affiliate.shopee.*`, memakai App ID + Secret, bukan Partner ID/Key.

---

## Struktur

```
shopee-affiliate-app/
├── backend/
│   ├── src/
│   │   ├── index.js          # Express server
│   │   ├── db.js
│   │   ├── db-init.js
│   │   ├── routes/api.js
│   │   └── services/shopee.js
│   ├── package.json
│   └── Dockerfile
├── frontend/                 # Dark dashboard
│   ├── index.html
│   └── js/
├── database/
│   └── schema.sql
├── Dockerfile                # Root (untuk EasyPanel)
├── docker-compose.yml
├── .env.example
└── README.md
```

---

## API Endpoints (internal)

Semua endpoint butuh header `Authorization: Bearer $ADMIN_TOKEN`, kecuali yang
ditandai **publik**.

| Method | Path | Keterangan |
|--------|------|------------|
| GET | `/api/health` | Health check — **publik** |
| GET | `/api/auth/callback` | Callback OAuth Shopee — **publik** (dilindungi oleh `code` sekali pakai) |
| GET | `/api/auth/url` | Bangun link otorisasi toko |
| POST | `/api/auth/login` | Verifikasi admin token |
| GET | `/api/shops` | Daftar toko |
| POST | `/api/shops` | Tambah/update token toko manual |
| GET | `/api/affiliates` | List + performa |
| GET | `/api/campaigns` | Campaign |
| GET | `/api/dashboard/summary` | KPI summary |
| POST | `/api/sync/:shopId` | Tarik data AMS real |

---

## Keamanan

- `ADMIN_TOKEN` melindungi seluruh `/api`. Bila kosong di `NODE_ENV=production`,
  server membalas 503 — sengaja gagal-tertutup agar token toko tidak bocor.
- CORS mati secara default (frontend satu origin dengan backend). Set
  `CORS_ORIGIN` hanya bila frontend di-host terpisah.
- `access_token` / `refresh_token` masih disimpan **plaintext** di PostgreSQL.
  Pertimbangkan enkripsi at-rest bila database dapat diakses pihak lain.
