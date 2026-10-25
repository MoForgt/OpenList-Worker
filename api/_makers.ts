import app, { setSpaFallbackHtml } from "../src/backend/index"
import { materializeRequestBody } from "../src/backend/server/request-body"
import INDEX_HTML from "../dist/index.html"

// 构建期内联 dist/index.html：EdgeOne Node 云函数没有 ASSETS 绑定，
// 前端路由（/add、/@manage/* 等静态不存在的路径）会落到 Hono 兜底，
// 注入后由函数直接返回 SPA 壳（配合根级 middleware.js 的边缘改写双保险）。
setSpaFallbackHtml(INDEX_HTML)

export async function onRequest(context: any) {
  // EdgeOne Node 运行时会间歇性丢失尚未被消费的请求体（issue #112，
  // 探针实测失败率 ~7%~40%，Cloudflare 为 0）。这里在请求进入 Hono 之前
  // 立即物化小体积请求体，让「读 body」成为函数的第一个动作；此后所有
  // 内部 I/O（存储健康检查的 KV 往返等）都不再让 body 暴露在平台之下。
  // 大体积/分块请求体（上传、WebDAV、S3）不受影响，原样透传保持流式。
  const request = await materializeRequestBody(context.request)
  return app.fetch(request, context.env, context)
}

export default onRequest
