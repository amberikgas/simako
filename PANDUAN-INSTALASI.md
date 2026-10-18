# PANDUAN INSTALASI — Si-MAKO (Edisi GAS-PRO-API + Vercel)

Panduan ini memandu Anda memasang **Backend Google Apps Script (Pure REST API)** dan men-deploy **Frontend Si-MAKO ke Vercel** langkah demi langkah.

## Bagian 1: Instalasi Backend (Google Apps Script)

1. Buka [https://script.google.com](https://script.google.com) lalu klik **Proyek Baru (New Project)**.
2. Ubah nama proyek menjadi **Si-MAKO REST API Backend**.
3. Pada file `Code.gs` (atau ganti namanya menjadi `Kode.gs`), hapus seluruh kode bawaan lalu tempel (*paste*) seluruh isi dari berkas **`Kode.gs`** yang disertakan terpisah.
4. Tekan **Ctrl + S** (Simpan).
5. **Jalankan `setupAppEnvironment()` — HANYA SEKALI:**
   - Pada dropdown daftar fungsi di toolbar atas editor Apps Script, pilih **`setupAppEnvironment`**.
   - Klik tombol **Run (Jalankan)**.
   - Saat muncul jendela meminta izin akses (*Authorization required*), klik **Review permissions** -> pilih akun Google Anda -> klik **Advanced** -> klik **Go to Si-MAKO REST API Backend (unsafe)** -> klik **Allow (Izinkan)**.
   - Periksa panel **Execution log** di bagian bawah. Pastikan muncul catatan sukses beserta `SPREADSHEET_ID`, `ROOT_FOLDER_ID`, `UPLOADS_FOLDER`, dan `EXPORTS_FOLDER`.
   - Buka Google Drive Anda: folder **`Folder Si-MAKO`** beserta file **`Database - Si-MAKO Konveksi`** (berisi sheet `AppConfig` + 11 sheet operasional) sudah otomatis dibuat, dan email Google Anda sudah terdaftar otomatis sebagai **Owner** di sheet `Pengguna`.
   - **Jangan** menjalankan `setupAppEnvironment()` berulang kali dari akun berbeda agar tidak membuat folder/spreadsheet baru.
6. **Deploy sebagai Web App (REST API):**
   - Klik tombol **Deploy** di kanan atas -> pilih **New deployment**.
   - Klik ikon roda gigi di sebelah *Select type* -> pilih **Web app**.
   - Isi konfigurasi berikut secara persis:
     - **Description**: `Si-MAKO REST API v3`
     - **Execute as**: **Me** (Email Anda)
     - **Who has access**: **Anyone** (Siapa saja — wajib agar `fetch()` dari Vercel tidak terblokir CORS)
   - Klik **Deploy**.
   - Salin (**Copy**) **Web app URL** yang berakhiran `/exec` (contoh: `https://script.google.com/macros/s/AKfycb.../exec`).

## Bagian 2: Konfigurasi URL API di Frontend

1. Ekstrak berkas **`simako-vercel-frontend.zip`** ke sebuah folder di komputer Anda, misalnya `C:\simako-frontend`.
2. Pastikan di dalam folder tersebut langsung terlihat susunan berikut (tidak ada folder pembungkus lagi di dalamnya):
   - `index.html`
   - `vercel.json`
   - `css/style.css`
   - `js/app.js`
3. Buka berkas **`js/app.js`** menggunakan editor teks (VS Code / Notepad).
4. Pada baris ke-12, ganti nilai `GAS_URL` dengan URL `/exec` yang baru saja Anda salin dari Google Apps Script:
   ```javascript
   const GAS_URL = 'https://script.google.com/macros/s/AKfycbx_URL_ANDA_DI_SINI/exec';
   ```
5. Simpan perubahan pada berkas `js/app.js`.
   *(Tips: Apabila Anda sudah terlanjur men-deploy ke Vercel sebelum mengganti `GAS_URL`, Anda tetap bisa menempelkan URL `/exec` langsung melalui menu **Atur URL API Backend** pada layar masuk Si-MAKO di browser).*

## Bagian 3: Deploy Frontend ke Vercel

Anda dapat memilih salah satu dari dua metode berikut untuk men-deploy ke Vercel:

### Metode A — via Vercel CLI (Paling Cepat dari Terminal)

1. Buka terminal (**PowerShell** atau **Command Prompt**) dan arahkan langsung ke folder hasil ekstraksi tempat `index.html` berada:
   ```bash
   cd "C:\simako-frontend"
   ```
2. Pastikan perintah `dir` (Windows) atau `ls` (Mac/Linux) menampilkan `index.html`, `css`, dan `js` di baris teratas.
3. Jalankan perintah deploy Vercel:
   ```bash
   npx vercel --prod
   ```
4. Ikuti petunjuk login singkat di layar (tekan Enter untuk pengaturan default). Dalam beberapa detik, Vercel akan memberikan URL produksi seperti `https://simako-frontend.vercel.app`.

### Metode B — via GitHub + Dashboard Vercel (Otomatis Update Setiap Push)

1. Buka terminal di dalam folder hasil ekstraksi (`C:\simako-frontend` — tempat `index.html` berada di root), lalu jalankan:
   ```bash
   git init
   git add .
   git commit -m "Initial commit Si-MAKO GAS-PRO-API"
   git branch -M main
   git remote add origin https://github.com/USERNAME/NAMA-REPO.git
   git push -u origin main
   ```
2. Buka [https://vercel.com/new](https://vercel.com/new), login dengan akun GitHub Anda, lalu klik **Import** pada repositori tersebut.
3. Biarkan **Framework Preset** pada pilihan *Other* dan **Root Directory** pada `./`, lalu klik **Deploy**.

## Bagian 4: Pengujian Aplikasi (Test Checklist)

1. Buka URL Vercel Anda di browser.
2. Pada **Layar Masuk Si-MAKO**, masukkan alamat email Google yang Anda gunakan saat menjalankan `setupAppEnvironment()` (atau email lain yang telah didaftarkan pada sheet `Pengguna` dengan status `Aktif = Ya`).
3. Klik **Masuk ke Dashboard** dan pastikan data awal berhasil dimuat (`doGet`).
4. Uji coba tambah pelanggan atau buat order baru (`doPost`) dan pastikan data langsung tercatat di Google Sheets.
5. Buka **Chrome DevTools (F12) -> tab Network**, pastikan seluruh request `POST` menggunakan `text/plain;charset=utf-8` dan berjalan lancar tanpa *CORS error*.
