# Pharmacy Control & Drug Master Intelligence Dashboard

แดชบอร์ดบริหารคลังยาและระบบฐานข้อมูลทะเบียนยา 350 SKU ออกแบบตาม [DESIGN-starbucks.md](./DESIGN-starbucks.md)

## Live GitHub Pages
- **Inventory & Dispense Operations Center (`index.html`)**: https://kanong2521.github.io/pharmacy-dashboard-update/
- **Drug Master Intelligence (`drug_dashboard.html`)**: https://kanong2521.github.io/pharmacy-dashboard-update/drug_dashboard.html

## ความสามารถหลัก
- **Zero Horizontal Scroll Responsive Tables**: ตารางปรับรูปแบบเป็นการ์ด 2 คอลัมน์อัตโนมัติบนแท็บเล็ตและมือถือ แสดงครบทุกฟิลด์โดยไม่ต้องเลื่อนแนวนอน
- **Live Time Ticker & IANA Timezone Switcher (`datetime-ui.js` / `datetime-ui.css`)**: นาฬิกาเรียลไทม์, สลับระบบปี พ.ศ. / ค.ศ., ปฏิทินและ Time Picker แบบ Top-Layer Popover, และตรวจจับ DST Transition Conflicts
- **JSON Sync (`sync-store.js`)**:
  - บน **GitHub Pages (Static Web)**: อ่านข้อมูลจาก `data/drugs_update.json`, `data/stock.json`, `data/dispense-log.json` พร้อมรองรับการอัปโหลด/วาง JSON หรือกรอกฟอร์มด่วนเพื่อซิงก์ข้ามแท็บผ่านเบราว์เซอร์ (`localStorage` + `BroadcastChannel`) รวมถึงเชื่อมต่อโฟลเดอร์ `data/` บน Chrome ผ่าน File System Access API และ Export JSON ออกมาใช้งานต่อได้
  - บน **Localhost (`node sync-server.mjs`)**: รองรับ Disk Read/Write แบบ Atomic ลงไฟล์ `data/*.json` บนเครื่องโดยตรง (`http://localhost:8765/`)

## โครงสร้างไฟล์
- `index.html` — แดชบอร์ดสต็อกรายล็อต วันหมดอายุ Reorder และประวัติจ่ายยา
- `drug_dashboard.html` — แดชบอร์ดทะเบียนยามาตรฐานกลาง 350 SKU (WHO ATC 2026)
- `sync-store.js` / `sync-server.mjs` — ระบบซิงก์ข้อมูล JSON ทั้งแบบ Static Browser และ Local Node Disk API
- `datetime-ui.js` / `datetime-ui.css` — ระบบ Live Time Ticker, Date & Time Picker และ Timezone Conversion
- `data/` — ชุดข้อมูลตัวอย่าง (`drugs_update.json`, `stock.json`, `dispense-log.json`)
