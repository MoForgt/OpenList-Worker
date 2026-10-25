/**
 * 「请求体丢失自动重试」注入脚本（issue #112 的用户侧兜底）。
 *
 * 由 scripts/fetch-frontend.mjs 在构建期注入 dist/index.html 的 <head>，
 * 也可被回归测试（scripts/_regress.mjs）直接导入做行为验证。
 * 设计说明见 fetch-frontend.mjs 的 patchNetworkRetry()。
 *
 * 内容约束：不得包含反引号 / ${ / </script（模板字符串安全 + HTML 内联安全）。
 */
export const RETRY_PATCH_SCRIPT = `<script>
/* OpenList build-time patch: transparent retry for "X-Request-Body-Lost" (issue #112).
 * EdgeOne intermittently drops POST bodies; the server rejects such requests
 * with 400 + X-Request-Body-Lost: 1 BEFORE any handler runs, so retrying is
 * always safe. Wraps XMLHttpRequest (axios transport) and fetch. */
;(function () {
  if (window.__openlistBodyRetry) return
  window.__openlistBodyRetry = true
  var MAX_RETRIES = 3
  var DELAYS = [100, 300, 600]
  var MARKER = "x-request-body-lost"
  var RS = typeof ReadableStream !== "undefined" ? ReadableStream : null

  function marked(res) {
    try {
      return res.status === 400 && res.headers.get(MARKER) === "1"
    } catch (e) {
      return false
    }
  }

  // ---- fetch ----
  var _fetch = window.fetch
  if (typeof _fetch === "function") {
    window.fetch = function (input, init) {
      var canRetry = false
      try {
        if (typeof input === "string" || input instanceof URL) {
          var m = ((init && init.method) || "GET").toUpperCase()
          var b = init && init.body
          canRetry =
            m !== "GET" && m !== "HEAD" && b != null &&
            !(RS && b instanceof RS)
        }
      } catch (e) {}
      var p = _fetch.apply(window, arguments)
      if (!canRetry) return p
      return p.then(function (res) {
        if (!marked(res)) return res
        var attempt = 0
        function again() {
          if (attempt >= MAX_RETRIES) return Promise.resolve(res)
          var delay = DELAYS[attempt] || 500
          return new Promise(function (r) {
            setTimeout(r, delay)
          }).then(function () {
            attempt++
            return _fetch.call(window, input, init).then(function (r2) {
              if (marked(r2)) return again()
              return r2
            })
          })
        }
        return again()
      })
    }
  }

  // ---- XMLHttpRequest (axios default browser transport) ----
  var RealXHR = window.XMLHttpRequest
  if (typeof RealXHR === "function" && RealXHR.prototype) {
    var WATCHED = {
      onreadystatechange: 1, onload: 1, onerror: 1, onabort: 1,
      ontimeout: 1, onloadend: 1,
    }
    var KIND = { load: "onload", error: "onerror", abort: "onabort", timeout: "ontimeout" }
    function Wrapped() {
      var xhr = new RealXHR()
      var handlers = {}
      var st = {
        method: "GET", url: "", async: true, user: null, password: null,
        headers: [], body: null, attempts: 0, timer: null, done: false,
      }
      var lastEvent = null
      var kind = "load"

      function deliver() {
        if (st.done) return
        st.done = true
        var fire = function (name) {
          var h = handlers[name]
          if (typeof h === "function") {
            try { h.call(proxy, lastEvent) } catch (e) {}
          }
        }
        fire("onreadystatechange")
        fire(KIND[kind] || "onload")
        fire("onloadend")
      }
      var classify = ["load", "error", "abort", "timeout"]
      for (var ci = 0; ci < classify.length; ci++) {
        ;(function (k) {
          xhr.addEventListener(k, function (ev) {
            lastEvent = ev
            kind = k
          })
        })(classify[ci])
      }
      xhr.addEventListener("loadend", function (ev) {
        lastEvent = ev || lastEvent
        if (st.done) return
        var retryable = false
        try {
          retryable =
            st.body != null &&
            st.attempts > 0 && st.attempts <= MAX_RETRIES &&
            xhr.status === 400 &&
            xhr.getResponseHeader(MARKER) === "1"
        } catch (e) {}
        if (!retryable) {
          deliver()
          return
        }
        var delay = DELAYS[st.attempts - 1] || 500
        st.attempts++
        st.timer = setTimeout(function () {
          st.timer = null
          if (st.done) return
          try {
            xhr.open(st.method, st.url, st.async, st.user, st.password)
            for (var i = 0; i < st.headers.length; i++) {
              xhr.setRequestHeader(st.headers[i][0], st.headers[i][1])
            }
            xhr.send(st.body)
          } catch (e) {
            kind = "error"
            deliver()
          }
        }, delay)
      })

      var base = function () {}
      var proxy = new Proxy(base, {
        get: function (t, k) {
          if (k in WATCHED) return handlers[k] === undefined ? null : handlers[k]
          switch (k) {
            case "open":
              return function (m, u, a, us, pw) {
                st.method = m
                st.url = u
                st.async = a === undefined ? true : !!a
                st.user = us === undefined ? null : us
                st.password = pw === undefined ? null : pw
                return xhr.open(m, u, st.async, st.user, st.password)
              }
            case "setRequestHeader":
              return function (n, v) {
                st.headers.push([n, String(v)])
              }
            case "send":
              return function (b) {
                st.body = b === undefined ? null : b
                st.attempts = 1
                for (var i = 0; i < st.headers.length; i++) {
                  xhr.setRequestHeader(st.headers[i][0], st.headers[i][1])
                }
                return xhr.send(st.body)
              }
            case "abort":
              return function () {
                if (st.timer) {
                  clearTimeout(st.timer)
                  st.timer = null
                  kind = "abort"
                  deliver()
                }
                try { xhr.abort() } catch (e) {}
              }
            case "getAllResponseHeaders": return xhr.getAllResponseHeaders.bind(xhr)
            case "getResponseHeader": return xhr.getResponseHeader.bind(xhr)
            case "overrideMimeType": return xhr.overrideMimeType.bind(xhr)
            case "addEventListener": return xhr.addEventListener.bind(xhr)
            case "removeEventListener": return xhr.removeEventListener.bind(xhr)
            case "dispatchEvent": return xhr.dispatchEvent.bind(xhr)
          }
          var v = xhr[k]
          return typeof v === "function" ? v.bind(xhr) : v
        },
        set: function (t, k, v) {
          if (k in WATCHED) {
            handlers[k] = typeof v === "function" ? v : null
          } else {
            try { xhr[k] = v } catch (e) {}
          }
          return true
        },
        has: function (t, k) {
          return k in WATCHED || k in xhr || k in RealXHR.prototype
        },
      })
      return proxy
    }
    Wrapped.prototype = RealXHR.prototype
    window.XMLHttpRequest = Wrapped
  }
})()
</script>
`
