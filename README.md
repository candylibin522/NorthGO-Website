# Northgo 網站重建成果

開啟 `index.html` 作為成果入口，或直接開啟 `northgo-site/zh-tw/index.html` 瀏覽新版。

## 新版網站

目前版本為 1.1.0，版本號記錄在 `VERSION`，建置時會顯示在各頁頁尾。

- `node build-northgo.mjs` 產生四語系共 60 個 HTML 頁面。編輯 `site-assets/content.js` 與 `site-assets/offices.js` 後重新產生。
- `node serve-northgo.mjs` 啟動本機網站，預設網址為 `http://127.0.0.1:4180`。可設定 `PORT`。
- 透過伺服器送出的詢問會儲存在 `.northgo-inbox`。每筆包含收件編號、服務、辦公室、語系與收件時間。該資料夾不在網頁根目錄下。
- 設定經核准的 HTTPS 收件網址 `NORTHGO_ENQUIRY_WEBHOOK`（必要時另設 `NORTHGO_ENQUIRY_TOKEN`），再執行 `node dispatch-northgo.mjs` 投遞待處理詢問。每次執行會重試未成功的紀錄。接收端應以 `Idempotency-Key` 去除重複資料，並依 service 與 recipient 欄位分派。執行時請排程為單一執行個體。
- 設定 `NORTHGO_SITE_URL` 為正式網址後重新建置，產生對應的 canonical、hreflang 與 XML sitemap。Node 伺服器包含原有服務、聯絡與法律路徑的 301 轉址。
- 正式發布前需審核四語系法律文案、設定企業收件或 CRM、確認資料保留及存取權限，並驗收正式網域上的轉址。

- `northgo-new.html`：原型及產生各語系頁面所用的 HTML 模板。
- `northgo-rebuild-plan.html`：分析、優化與正式上線方案。
- `northgo-sitemap.html`：原官網的四語系網站地圖。
- `northgo-sitemap-tree.html`：原官網的精簡樹狀地圖。
- `northgo-offices.html`：獨立全球辦公室地圖。
- `site-assets/`、`office-assets/`、`sitemap*.js/css`：必要素材及程式，移動成果時一併保留。

## 已實作

四語系獨立頁面、服務內容、公司沿革、可縮放與篩選的辦公室地圖、手機導覽，以及詢問表單和伺服器收件。語系切換對應目前頁面。地圖使用本地國界。

## 正式上線前

GitHub Pages 的發布來源使用 GitHub Actions。推送到 `main` 或 `master` 會觸發 Pages 工作流程。Pages 版的詢問表單產生電子郵件草稿，本機 Node 版提供直接收件。

正式發布需完成企業收件端設定、法務及翻譯審校、效能與無障礙稽核，以及正式網域的轉址驗收。正式法律頁目前顯示審核狀態和聯絡方式。

## 資料與素材

公司資料、地址、聯絡方式及照片取自 Northgo 公開網站。正式公開發布前請確認素材使用權。地圖標記為城市概略位置，完整地址列於據點清單。

地圖使用 Leaflet 1.9.4。世界國界取自 Natural Earth，透過 datasets/geo-countries 取得，使用 Leaflet LineUtil 簡化供視覺展示。原始 GeoJSON 保留於 office-assets/countries.geojson。

## 驗證

本機 HTTP 驗證涵蓋四語系 24 個頁面、舊網址轉址、XML sitemap、拒收未同意資料、有效收件、重試去重與資料衝突。收件驗證使用隔離的暫存資料夾。正式投遞、Core Web Vitals 與完整 WCAG 驗收待正式環境。
