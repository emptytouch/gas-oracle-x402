// Test fixtures + a hermetic mock x402 facilitator.
//
// The x402 resource server contacts the facilitator's /supported endpoint at
// request time to learn which schemes it can verify. We stand up a tiny local
// HTTP server that answers /supported (and /verify, /settle) so the suite never
// needs outbound network — it passes in the sandbox, on a laptop, and in CI.
import http from "node:http";

process.env.NODE_ENV = "test";
process.env.PAY_TO = process.env.PAY_TO || "0x9e610Cd701472bF7C815a6404B6ff88D81838C91";
process.env.KITE_NETWORK = process.env.KITE_NETWORK || "testnet";
process.env.RATE_LIMIT_PER_MIN = process.env.RATE_LIMIT_PER_MIN || "10";

const facilitator = http.createServer((req, res) => {
  const url = req.url ?? "";
  if (req.method === "GET" && url === "/supported") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:2368", extra: {} }],
        extensions: [],
        signers: {},
      }),
    );
    return;
  }
  if (req.method === "POST" && url === "/verify") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ valid: true }));
    return;
  }
  if (req.method === "POST" && url === "/settle") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        success: true,
        transaction: "0x0000000000000000000000000000000000000000000000000000000000000001",
      }),
    );
    return;
  }
  res.writeHead(404);
  res.end();
});

facilitator.listen(5959, "127.0.0.1");
facilitator.unref(); // don't keep the test process alive
process.env.FACILITATOR_URL = "http://127.0.0.1:5959";
