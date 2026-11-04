import proxyAddr from "@fastify/proxy-addr";
import type {
  BunAdapterOptions,
  BunTrustProxy,
} from "../interfaces/bun-adapter-options.interface.js";
import { BunRequest } from "./bun-request.js";
import { getHostname } from "./utils/hostname.util.js";

type TrustFunction = (address: string, hop: number) => boolean;

/**
 * Compiles the `trustProxy` option the way Fastify compiles its own (and
 * Express its "trust proxy" setting, but for a hop count).
 */
function compileTrust(
  trustProxy: Exclude<BunTrustProxy, false>,
): TrustFunction {
  if (typeof trustProxy === "function") {
    return trustProxy;
  }
  if (trustProxy === true) {
    return () => true;
  }
  if (typeof (trustProxy as unknown) === "number") {
    // As with Fastify: a hop count cannot tell the socket's peer from a client
    // that sends its own X-Forwarded-For, so it trusts no proxy
    return () => false;
  }
  return proxyAddr.compile(
    typeof trustProxy === "string"
      ? trustProxy.split(",").map((entry) => entry.trim())
      : trustProxy,
  );
}

// Proxies may join several values with ","; Express reads the first one
function firstValue(header: string): string {
  const index = header.indexOf(",");
  return (index === -1 ? header : header.slice(0, index)).trim();
}

/**
 * The class of the requests of an adapter whose options change how requests
 * read the query string or the headers of proxies: a subclass of
 * `BunRequest` overriding those getters. Without such options, it is
 * `BunRequest` itself, so that requests run the same code as without this
 * function.
 *
 * @internal
 */
export function createRequestClass(
  options: Pick<BunAdapterOptions, "trustProxy" | "querystringParser">,
): typeof BunRequest {
  const { trustProxy, querystringParser } = options;
  let RequestClass = BunRequest;

  if (querystringParser !== undefined) {
    if (typeof querystringParser !== "function") {
      throw new TypeError(
        `Invalid querystringParser: ${String(querystringParser)} (expected a function)`,
      );
    }
    const QUERY = Symbol("query");
    RequestClass = class extends RequestClass {
      declare [QUERY]: Record<string, any> | undefined;

      get query(): Record<string, any> {
        let query = this[QUERY];
        if (query === undefined) {
          const url = this.url!;
          const index = url.indexOf("?");
          // As Fastify calls it: with "" for a URL without a query string
          query = this[QUERY] = querystringParser(
            index === -1 ? "" : url.slice(index + 1),
          );
        }
        return query;
      }

      set query(value: Record<string, any>) {
        this[QUERY] = value;
      }
    };
  }

  if (trustProxy !== undefined && trustProxy !== false) {
    const trust = compileTrust(trustProxy);
    // Whether the socket's peer is a proxy whose headers count
    const isFromTrustedProxy = (req: BunRequest) =>
      trust(req.socket?.remoteAddress as string, 0);
    const app = Object.freeze({
      get(setting: string): unknown {
        if (setting === "trust proxy") {
          return trustProxy;
        }
        return setting === "trust proxy fn" ? trust : undefined;
      },
    });
    RequestClass = class extends RequestClass {
      get ip(): string | undefined {
        return proxyAddr(this, trust);
      }

      get ips(): string[] {
        // From the client to the closest proxy, without the socket's peer
        const addresses = proxyAddr.all(this, trust);
        addresses.reverse().pop();
        return addresses;
      }

      get protocol(): string {
        // Bun joins repeated headers with ", "
        const header = this.headers["x-forwarded-proto"] as string | undefined;
        return header && isFromTrustedProxy(this)
          ? firstValue(header)
          : super.protocol;
      }

      get hostname(): string | undefined {
        const header = this.headers["x-forwarded-host"] as string | undefined;
        return getHostname(
          header && isFromTrustedProxy(this)
            ? firstValue(header)
            : this.headers.host,
        );
      }

      get app(): { get(setting: string): unknown } {
        return app;
      }
    };
  }

  return RequestClass;
}
