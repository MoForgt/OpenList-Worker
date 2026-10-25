/**
 * 请求体立即物化（issue #112 修复的源头层）。
 *
 * 背景：EdgeOne Node 云函数运行时会间歇性丢失/截断尚未被消费的请求体
 * （issue #112 探针实验：同一份代码 EdgeOne 失败率 ~7%~40%，Cloudflare 为 0，
 * 且失败率与并发/连接复用无关）。失败窗口与「请求进入函数后先做了其它 I/O、
 * 请求体迟迟未被读取」强相关：本项目在 JSON body 校验中间件之前还有存储
 * 健康检查（EdgeOne 上是一次 KV 自代理 HTTP 往返），请求体在这段空窗期
 * 持续暴露在平台运行时之下。
 *
 * 对策：在平台入口（api/_makers.ts，请求进入 Hono 之前）就把小体积请求体
 * 一次性读入内存，并用缓冲重建 Request —— 让「读请求体」成为函数的第一个
 * 动作，把平台丢 body 的窗口压缩到最短；此后全部 I/O（KV、数据库、上游
 * 存储）都发生在请求体已安全落袋之后。
 *
 * 范围控制（避免破坏流式上传）：
 * - 仅处理带 Content-Length 且 <= EAGER_BODY_LIMIT 的请求体。浏览器发出的
 *   JSON API 请求（fs/list、fs/mkdir 等）体积极小，全部命中；
 * - 大体积上传（/api/fs/put、WebDAV、S3、raw 转存）或分块传输（无
 *   Content-Length）原样透传，保持流式语义与内存占用不变；
 * - 读取中途抛异常（平台已把流弄断）时不吞错、不重试：返回原请求，
 *   由 jsonBodyGuard 给出显式 400 + X-Request-Body-Lost 标记，前端注入的
 *   重试层据此自动重发（该 400 发生在任何业务 handler 之前，重试绝对安全）。
 */
export const EAGER_BODY_LIMIT = 1024 * 1024

const BODYLESS_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

export async function materializeRequestBody(
  req: Request,
): Promise<Request> {
  try {
    const method = req.method.toUpperCase()
    if (BODYLESS_METHODS.has(method)) return req
    if (!req.body) return req
    const len = parseInt(req.headers.get("content-length") || "", 10)
    if (!Number.isFinite(len) || len <= 0 || len > EAGER_BODY_LIMIT) return req
    const buffered = await req.arrayBuffer()
    return new Request(req.url, {
      method,
      headers: req.headers,
      body: buffered,
    })
  } catch {
    // 平台已破坏请求流（读一半抛异常）：无法恢复，交回原请求走显式失败路径
    return req
  }
}
