# 小鹿號遊戲正式部署

這個專案需要可以執行 Node.js 與 Python 的雲端主機，因為它包含即時控制、圖片上傳、排行榜與去背處理。

## 建議部署方式

使用 Render、Railway 或 Fly.io 這類支援 Docker 的主機。專案已經補好：

- `Dockerfile`
- `requirements.txt`
- `render.yaml`
- `/api/health` 健康檢查

## Render 部署流程

1. 將 `deer-monster-tv-game` 上傳到 GitHub repository。
2. 到 Render 建立新的 Web Service。
3. 選擇該 GitHub repository。
4. Environment 選擇 Docker。
5. Health Check Path 設為 `/api/health`。
6. 部署完成後，Render 會提供一個固定網址。

## 使用方式

正式網址假設是：

```text
https://your-game-host.example.com
```

電視畫面：

```text
https://your-game-host.example.com/screen
```

手機上傳與控制網址可以從：

```text
https://your-game-host.example.com/api/session
```

取得 `uploadUrl`。

## 活動前提醒

- 免費或低階主機可能會休眠，正式活動建議使用不會自動休眠的方案。
- 去背模型第一次執行可能需要較久時間，活動開始前建議先上傳一張測試圖片暖機。
- 目前排行榜與場上玩家資料存在記憶體中，主機重啟後會清空。
