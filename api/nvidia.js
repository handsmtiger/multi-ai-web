// NVIDIA API 프록시 — Vercel 서버리스 함수
//
// 배포 방법: 이 파일을 GitHub repo의 api 폴더 안에 nvidia.js 라는 이름으로
// 넣으세요 (repo 루트/index.html, repo 루트/api/nvidia.js 구성).
// Vercel이 자동으로 /api/nvidia 엔드포인트로 배포합니다.
//
// 역할: 브라우저가 보낸 NVIDIA 요청을 이 함수가 대신 NVIDIA 서버로 전달합니다.
// NVIDIA API는 build.nvidia.com 이외의 웹페이지에서 오는 브라우저 직접 호출을
// CORS 정책으로 차단하지만, 서버에서 보내는 호출은 차단하지 않습니다.
// API 키는 이 함수로만 전달되고 어디에도 저장되지 않습니다.
//
// 허용 경로 (path 쿼리 파라미터):
//   v1/models            -> https://integrate.api.nvidia.com/v1/models
//   v1/chat/completions  -> https://integrate.api.nvidia.com/v1/chat/completions
//   genai/<... 나머지>   -> https://ai.api.nvidia.com/v1/genai/<... 나머지>
// 그 외 경로는 400으로 거부합니다 (공개 프록시로 악용 방지).

module.exports = async function handler(req, res) {
  res.setHeader("x-ai-proxy", "nvidia");

  var rawPath = (req.query && req.query.path) || "";
  if (Array.isArray(rawPath)) rawPath = rawPath.join("/");
  var path = String(rawPath).replace(/^\/+/, "");

  var upstream = null;
  if (path === "v1/models" || path === "v1/chat/completions") {
    upstream = "https://integrate.api.nvidia.com/" + path;
  } else if (path.indexOf("genai/") === 0 && path.length > "genai/".length) {
    upstream = "https://ai.api.nvidia.com/v1/" + path;
  }
  if (!upstream) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: { message: "허용되지 않은 프록시 경로입니다: " + path } }));
    return;
  }

  // 요청 본문을 그대로 읽습니다 (bodyParser 비활성화 설정은 파일 하단 참조).
  var chunks = [];
  await new Promise(function (resolve, reject) {
    req.on("data", function (c) { chunks.push(c); });
    req.on("end", resolve);
    req.on("error", reject);
  });
  var body = Buffer.concat(chunks);

  var headers = {};
  if (req.headers.authorization) headers["Authorization"] = req.headers.authorization;
  if (req.headers["content-type"]) headers["Content-Type"] = req.headers["content-type"];
  if (req.headers.accept) headers["Accept"] = req.headers.accept;

  var init = { method: req.method, headers: headers };
  if (req.method !== "GET" && req.method !== "HEAD" && body.length) init.body = body;

  var upstreamRes;
  try {
    upstreamRes = await fetch(upstream, init);
  } catch (e) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: { message: "프록시가 NVIDIA 서버에 연결하지 못했습니다: " + (e && e.message ? e.message : String(e)) } }));
    return;
  }

  res.statusCode = upstreamRes.status;
  var ct = upstreamRes.headers.get("content-type");
  if (ct) res.setHeader("Content-Type", ct);
  res.setHeader("Cache-Control", "no-store");

  if (!upstreamRes.body) { res.end(); return; }
  // 응답을 스트리밍으로 그대로 흘려보냅니다 (채팅 SSE 스트리밍 유지).
  var reader = upstreamRes.body.getReader();
  try {
    for (;;) {
      var step = await reader.read();
      if (step.done) break;
      res.write(Buffer.from(step.value));
    }
  } catch (e) {
    // 스트림 중간 오류 — 이미 응답이 시작됐으므로 그대로 종료합니다.
  }
  res.end();
};

// Vercel이 요청 본문을 미리 파싱하지 않도록 합니다 (원본 그대로 전달).
module.exports.config = { api: { bodyParser: false } };
