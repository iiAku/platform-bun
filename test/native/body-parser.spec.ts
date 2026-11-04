import { BunAdapter } from "../../src/index.js";
import { NATIVE_REQUEST } from "../../src/transport/native-request.js";

describe("bounded native body reader", () => {
  it("uses native bytes() for small bodies with parser verification and stream completion preserved", async () => {
    const adapter = new BunAdapter();
    const verify = vi.fn();
    let read: ReturnType<typeof vi.spyOn>;
    adapter.initHttpServer({});
    adapter.use((req, _res, next) => {
      read = vi.spyOn(req[NATIVE_REQUEST], "bytes");
      next();
    });
    // The parser useBodyParser("json") installs, given a verify callback.
    const { json } = await import("../../src/body-parser/body-parser.js");
    adapter.use(json({ verify }));
    adapter.post("/", (req, res) =>
      res.json({ body: req.body, ended: req.readableEnded }),
    );
    try {
      await new Promise<void>((resolve) =>
        adapter.listen(0, "127.0.0.1", resolve),
      );
      const port = (adapter.getHttpServer().address() as any).port;
      const text = '{"hello":"Bun"}';
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: text,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        body: { hello: "Bun" },
        ended: true,
      });
      expect(read!).toHaveBeenCalledOnce();
      expect(verify).toHaveBeenCalledOnce();
      expect(verify.mock.calls[0][2]).toEqual(Buffer.from(text));
      expect(verify.mock.calls[0][3]).toBe("utf-8");
    } finally {
      await adapter.close();
    }
  });
});
