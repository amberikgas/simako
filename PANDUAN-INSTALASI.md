# PANDUAN INSTALASI — Si-MAKO v3.1 (GAS-PRO-API + Vercel)

Panduan ini memandu pemasangan **Backend Google Apps Script (REST API)** dan **Frontend di Vercel** untuk satu usaha konveksi, langkah demi langkah.

> **Pakai akun Google milik klien** (pemilik usaha), bukan akun Anda sendiri sebagai pemasang. Data, spreadsheet, dan kode backend akan berada di Google Drive akun tersebut.

## Bagian 1: Backend (Google Apps Script)

1. Buka [https://script.google.com](https://script.google.com) lalu klik **Proyek Baru (New Project)**.
2. Ubah nama proyek menjadi **Si-MAKO REST API Backend**.
3. Buka file `Code.gs`, hapus seluruh isinya, lalu tempel seluruh isi berkas **`Kode.gs`** v3.1. Tekan **Ctrl + S**.
4. **Jalankan `setupAppEnvironment()` — CUKUP SEKALI:**
   - Pada dropdown fungsi di toolbar, pilih **`setupAppEnvironment`**, lalu klik **Run**.
   - Saat diminta izin, klik **Review permissions**, pilih akun Google klien, klik **Advanced**, klik **Go to Si-MAKO REST API Backend (unsafe)**, lalu klik **Allow**.
   - Periksa **Execution log**. Harus ada tiga hal:
     - ID spreadsheet & folder.
     - Baris **`🔑 Sandi sementara Owner`**, contoh `pemilik@gmail.com → k7mqp2xwtr`. **Catat sandi ini** dan berikan kepada Owner.
     - Baris `✅ Trigger keepWarm ... aktif`.
   - Di Google Drive, pastikan folder **`Folder Si-MAKO`** dan file **`Database - Si-MAKO Konveksi`** (sheet `AppConfig` + 11 sheet) sudah terbentuk. Email akun klien otomatis terdaftar sebagai **Owner** di sheet `Pengguna`.
5. **Deploy sebagai Web App:**
   1. Klik **Deploy → New deployment**, klik ikon roda gigi, lalu pilih **Web app**.
   2. Isi pengaturannya:
      - **Description**: `Si-MAKO v3.1`
      - **Execute as**: **Me**
      - **Who has access**: **Anyone**. Pilihan ini wajib agar `fetch()` dari Vercel tidak terblokir. Aksesnya tetap aman karena setiap permintaan data wajib membawa token login.
   3. Klik **Deploy**, lalu salin **Web app URL** yang berakhiran `/exec`.

## Bagian 2: Konfigurasi frontend

1. Siapkan folder frontend dengan susunan berikut:
   ```
   index.html
   vercel.json
   css/style.css
   js/config.js     ← satu-satunya file yang diedit per klien
   js/app.js
   ```
2. Buka **`js/config.js`**, lalu isi `GAS_URL` dengan URL `/exec` klien:
   ```javascript
   window.SIMAKO_CONFIG = {
     GAS_URL: 'https://script.google.com/macros/s/AKfycb..._URL_KLIEN_.../exec'
   };
   ```
3. Simpan. **Jangan** mengedit `app.js`.

> Kotak "Atur URL API Backend" di layar masuk sengaja disembunyikan dari pengguna. Untuk keperluan teknisi, buka aplikasi dengan akhiran `?setup=1`, misalnya `https://app-klien.vercel.app/?setup=1`.

## Bagian 3: Deploy frontend ke Vercel

**Metode A — Vercel CLI**
```bash
cd "C:\simako-klien-x"
npx vercel --prod
```

**Metode B — GitHub + Dashboard Vercel**
```bash
git init
git add .
git commit -m "Si-MAKO v3.1"
git branch -M main
git remote add origin https://github.com/USERNAME/NAMA-REPO.git
git push -u origin main
```
Setelah itu buka [vercel.com/new](https://vercel.com/new), klik **Import** pada repo tersebut. Biarkan **Framework Preset** pada *Other* dan **Root Directory** pada `./`, lalu klik **Deploy**.

## Bagian 4: Uji coba

1. Buka URL Vercel. Layar masuk harus meminta **email + sandi**.
2. Masuk dengan email Owner + sandi sementara dari log. Aplikasi akan **mewajibkan pembuatan sandi baru** (minimal 8 karakter).
3. Pastikan dashboard tampil, lalu uji tambah pelanggan dan buat order. Cek data tercatat di Google Sheets.
4. Muat ulang halaman. Aplikasi harus langsung tampil tanpa menunggu.
5. Tekan F12, buka tab **Network**, dan pastikan semua `POST` memakai `text/plain;charset=utf-8` tanpa *CORS error*. Ketik `Perf.summary()` di tab **Console** untuk melihat waktu respons.

## Bagian 5: Menambah Admin (staf)

1. Owner membuka **Pengaturan → + Tambah Pengguna**, lalu mengisi email, nama, dan peran **Admin**, kemudian klik **Simpan**.
2. Aplikasi menawarkan **Buat Sandi Sementara**. Sandi tampil **sekali**; klik **Salin** atau **Kirim lewat WhatsApp**.
3. Admin masuk dengan sandi itu dan wajib membuat sandi sendiri.
4. Admin lupa sandi? Owner membuka **Detail** pengguna lalu klik **Buat Sandi Sementara** lagi.

## Bagian 6: Lupa sandi Owner

Buka editor Apps Script, jalankan fungsi **`resetSandiOwner`**, lalu baca sandi sementara baru di **Execution log**.

## Bagian 7: Update kode di kemudian hari

Selalu lewat **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. Jangan memakai "New deployment", karena URL `/exec` akan berubah dan aplikasi di Vercel berhenti tersambung.

## Catatan kuota & pemeliharaan

- Trigger `keepWarm` (tiap 10 menit, 06:00–22:00 WIB) menjaga aplikasi tetap cepat. Pemakaiannya diperkirakan beberapa menit per hari dari kuota trigger, yang untuk akun Gmail gratis sekitar 90 menit per hari. Fungsi pengaturnya:
  - `matikanKeepWarm()` untuk mematikan.
  - `nyalakanKeepWarm()` untuk menyalakan lagi.
- `cekPerforma()` menampilkan status cache, trigger, dan ukuran Script Properties.
- Jangan menghapus `TOKEN_SECRET` di **Project Settings → Script Properties**. Bila terhapus, semua pengguna perlu masuk ulang; data tidak hilang.
