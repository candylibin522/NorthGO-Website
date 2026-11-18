# Northgo 網站重建成果

開啟 `index.html` 作為成果入口，或直接開啟 `northgo-site/zh-tw/index.html` 瀏覽新版。

## 新版網站

目前版本為 1.2.0，版本號記錄在 `VERSION`，建置時會顯示在各頁頁尾。

## 詢問管理後台

使用 Node.js 24 或以上執行 `node serve-northgo.mjs`。開啟終端顯示的 `/admin/` 網址。
首次於本機開啟後台會顯示建立帳號表單，請自行設定帳號與至少 12 字元的密碼。
首次設定僅允許非 production 模式的本機連線，後續開啟即為登入畫面。

- 後台提供搜尋、狀態／服務／據點篩選、分頁、詢問詳情、客戶資料修正、負責人、內部備註、封存與修改紀錄。
- 待處理、處理中、已回覆及已封存是人工處理狀態。「已回覆」由管理者更新，回覆信件使用既有聯絡流程。
- 原始詢問保存在 `.northgo-inbox`。資料修正、修改歷程、密碼雜湊與工作階段保存在 `.northgo-private/admin.sqlite`，不在公開網頁目錄內。
- `NORTHGO_INBOX_DIR` 與 `NORTHGO_DATA_DIR` 可指定持久化資料目錄。部署或升級請保留並備份這兩個目錄，勿存入 Git。
- 投遞程式使用後台修正過的客戶資料，略過已封存項目。內部備註不會送到客戶端或投遞端。
- 工作階段使用 HttpOnly、SameSite=Strict Cookie，8 小時後到期。後台可變更密碼，變更後所有工作階段失效。

### 連接 GitHub Pages 的公開詢問

GitHub Pages 僅部署靜態網站。管理後台與收件 API 需另部署於支援 Node.js 24 和持久化磁碟的主機。

1. 在本機完成初始帳號設定，再將資料目錄透過私有管道移到後端主機。
2. 後端設定 `NODE_ENV=production`、`NORTHGO_HOST=0.0.0.0`、`NORTHGO_SITE_URL`、資料目錄和 `NORTHGO_FRONTEND_ORIGINS=https://candylibin522.github.io`。
3. 後端放在 HTTPS 反向代理後方。production Cookie 僅透過 HTTPS 傳送，初始帳號設定在 production 模式停用。
4. 在 GitHub 儲存庫的 Actions Variables 設定 `NORTHGO_API_URL` 為後端的 HTTPS origin（例如 `https://api.example.com`），再重新部署 Pages。此值為公開網址。
5. 確認公開詢問送出後取得收件編號，且可登入後端主機的 `/admin/` 看到同一筆資料。

未指定後端網址的 Pages 版本保留郵件草稿流程。後台資料僅能管理由 API 收到的詢問，先前的郵件草稿不會自動匯入。

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
