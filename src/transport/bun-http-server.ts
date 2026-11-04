import { EventEmitter } from "node:events";
import { IncomingMessage, ServerResponse, STATUS_CODES } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable, Stream } from "node:stream";
import type {
  Server as BunNativeServer,
  TLSOptions as BunTLSOptions,
} from "bun";
import { drainMicrotasks } from "bun:jsc";
import {
  NATIVE_REQUEST,
  READ_NATIVE_BODY,
  REQUEST_HEADER,
} from "./native-request.js";

/** Options of the Bun native HTTP listener and its Node compatibility layer. */
export interface BunHttpServerOptions {
  requestClass?: typeof IncomingMessage;
  responseClass?: typeof ServerResponse;
  tls?: BunTLSOptions;
  maxRequestBodySize?: number;
}

type Listener = (req: IncomingMessage, res: ServerResponse) => void;

// Own fields of the requests, responses and connection facades. Symbols keep
// them out of the way of middleware that enumerates or patches properties.
const kServer = Symbol("bun.server");
const kResponse = Symbol("bun.response");
const kHeaders = Symbol("bun.headers");
const kRawHeaders = Symbol("bun.rawHeaders");
const kSocket = Symbol("bun.socket");
const kReader = Symbol("bun.reader");
const kState = Symbol("bun.state");
const kSignal = Symbol("bun.signal");
const kResolve = Symbol("bun.resolve");
const kNative = Symbol("bun.nativeResponse");
const kStream = Symbol("bun.stream");
const kError = Symbol("bun.error");
const kRequest = Symbol("bun.request");
const kRemote = Symbol("bun.remote");
const kSlot = Symbol("bun.slot");
const IDLE = Symbol("bun.idle");
/**
 * How long close() keeps the connections that were busy when it was called
 * open after their last reply, for the request a keep-alive client sends on
 * one once it has read the reply. Node keeps such a connection for its whole
 * keep-alive time; Bun cannot stop listening without closing it, so the port
 * stays bound meanwhile and the wait is kept short.
 */
const CLOSE_GRACE_MS = 250;
const FORCED = Symbol("bun.forced");

// Request state flags
const R_READING = 1;
const R_BODY_DONE = 2;
const R_ABORTED = 4;
const R_ARMED = 8;
const R_DUMPED = 16;
/** A body exists (Request.body is not null) and was not read yet. */
const R_BODY_PENDING = 32;
/** The Node stream of the request exists (see streamOf()). */
const R_STREAM = 64;
/** The stream ended before it existed: 'end' was due with nothing listening. */
const R_ENDED = 128;
/** The stream ended and closed before it existed. */
const R_SETTLED = 256;

// Response state flags
const S_FINISH_EMITTED = 1;
const S_CLOSED = 2;
const S_ARRAY_HEADER = 4;
// Bun's idle timer is held off for the request until its reply is complete
const S_IDLE_OFF = 8;

const HIGH_WATER_MARK = 16_384;
// Node reads its bodies in chunks; a body this small is read in one native
// call instead (see FetchRequest._read())
const SMALL_BODY = 65_536;

const EMPTY_ARRAY: readonly string[] = Object.freeze([]);
// As Node's IncomingMessage: a request is destroyed once its body has been
// consumed; a body nobody reads is dumped with the response
const READABLE_OPTIONS = { autoDestroy: true };

function noop() {}

// Prototype members, with `this` typed loosely: the members are shared by the
// adapter's request and response classes, which they only partly know
function members<T extends object>(
  definition: T & ThisType<any>,
): Record<string, PropertyDescriptor> {
  const descriptors = Object.getOwnPropertyDescriptors(definition);
  for (const descriptor of Object.values(descriptors)) {
    descriptor.enumerable = false;
  }
  return descriptors;
}

function errorWithCode(message: string, code: string, Ctor = Error) {
  return Object.assign(new Ctor(message), { code });
}

function headersSentError(action: string) {
  return errorWithCode(
    `Cannot ${action} headers after they are sent to the client`,
    "ERR_HTTP_HEADERS_SENT",
  );
}

function abortError() {
  return errorWithCode("aborted", "ECONNRESET");
}

// Header validation, as Node's validateHeaderName()/validateHeaderValue()
const TOKEN = /^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/;
const INVALID_HEADER_CHAR = /[^\t\x20-\x7e\x80-\xff]/;

// Applications set the same few header names on every response: validate and
// lower-case each name once
const headerKeys = new Map<string, string>();

function headerKey(name: string): string {
  let key = headerKeys.get(name);
  if (key === undefined) {
    if (typeof name !== "string" || !TOKEN.test(name)) {
      throw errorWithCode(
        `Header name must be a valid HTTP token ["${name}"]`,
        "ERR_INVALID_HTTP_TOKEN",
        TypeError,
      );
    }
    key = name.toLowerCase();
    if (headerKeys.size >= 1024) {
      headerKeys.clear();
    }
    headerKeys.set(name, key);
  }
  return key;
}

function validateHeaderValue(name: string, value: unknown) {
  if (value === undefined) {
    throw errorWithCode(
      `Invalid value "${value}" for header "${name}"`,
      "ERR_HTTP_INVALID_HEADER_VALUE",
      TypeError,
    );
  }
  if (typeof value !== "number" && INVALID_HEADER_CHAR.test(String(value))) {
    throw errorWithCode(
      `Invalid character in header content ["${name}"]`,
      "ERR_INVALID_CHAR",
      TypeError,
    );
  }
}

const statusLines: string[] = [];

function statusLine(statusCode: number) {
  return (statusLines[statusCode] ??=
    `HTTP/1.1 ${statusCode} ${STATUS_CODES[statusCode] ?? ""}\r\n`);
}

function hasNullBody(statusCode: number) {
  return statusCode === 204 || statusCode === 205 || statusCode === 304;
}

// The `ResponseInit`s of the responses, which Response() reads synchronously:
// each member it is given costs it a conversion, so a 200 leaves its status
// out, and only a response with a reason phrase of its own has one
const RESPONSE_INIT_OK: { headers: any } = { headers: undefined };
const RESPONSE_INIT: { status: number; headers: any } = {
  status: 200,
  headers: undefined,
};
const RESPONSE_INIT_TEXT: { status: number; statusText: string; headers: any } =
  { status: 200, statusText: "", headers: undefined };

type HeaderStore = Record<string, string | number | string[]>;

// The headers of a response given to Response() without its Content-Length:
// an object without a prototype, as the store
const HeaderInit = function () {} as unknown as new () => HeaderStore;
HeaderInit.prototype = Object.create(null);

// The responses whose only header is their Content-Type (the common replies)
// share a Headers per type: Response() copies one in a fraction of the time
// it takes to read the headers of an object
/** @internal */
export const typeHeaders = new Map<string, Headers>();

/** @internal */
export function contentTypeHeaders(type: string) {
  let headers = typeHeaders.get(type);
  if (headers === undefined) {
    if (typeHeaders.size >= 256) {
      typeHeaders.clear();
    }
    headers = new Headers({ "content-type": type });
    typeHeaders.set(type, headers);
  }
  return headers;
}

interface StreamState {
  controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  needDrain: boolean;
  /** Bytes still expected by an explicit Content-Length, else NaN. */
  remaining: number;
  /** end() ran. */
  ended: boolean;
  /** The controller is closed or errored: nothing more goes through it. */
  done: boolean;
  allowBody: boolean;
  /** The end() callback, while the body waits for Bun to take its chunks. */
  callback: (() => void) | undefined;
  /** Bytes handed to the body so far. */
  written: number;
  /** write() callbacks waiting for Bun to take their chunk, by byte offset. */
  pending: PendingWrite[] | undefined;
}

interface PendingWrite {
  at: number;
  callback: (error?: Error) => void;
}

// Node's default writable high-water mark; Bun pulls the body as the socket
// takes it, so a slow client holds the producer at this many queued bytes
const STREAM_STRATEGY = new ByteLengthQueuingStrategy({
  highWaterMark: HIGH_WATER_MARK,
});
// Bun sends a closed body stream with its Content-Length only when the whole
// queue is under the stream's high-water mark, and chunked otherwise
const ONE_BODY_STRATEGY = new ByteLengthQueuingStrategy({
  highWaterMark: Infinity,
});

/**
 * Request-scoped stand-in for the Node socket. Bun owns the TCP connection;
 * middleware sees the addresses, flags and events it reads. Created on first
 * access to `req.socket`, which also starts watching for client aborts.
 */
class ConnectionFacade extends EventEmitter {
  declare [kRequest]: any;
  declare [kRemote]: { address: string; port: number; family: string } | null;
  encrypted: boolean;
  destroyed = false;
  readable = true;
  writable = true;
  connecting = false;
  bytesRead = 0;
  bytesWritten = 0;
  timeout = 0;
  constructor(req: any) {
    super();
    this[kRequest] = req;
    this[kRemote] = null;
    this.encrypted = !!req[kServer].options.tls;
  }
  private remote() {
    return (this[kRemote] ??= this[kRequest][kServer].nativeServer?.requestIP(
      this[kRequest][NATIVE_REQUEST],
    ) ?? { address: "", port: 0, family: "IPv4" });
  }
  get server(): BunHttpServer {
    return this[kRequest][kServer].owner;
  }
  get remoteAddress() {
    return this.remote().address;
  }
  get remotePort() {
    return this.remote().port;
  }
  get remoteFamily() {
    return this.remote().family;
  }
  get localAddress() {
    return this[kRequest][kServer].nativeServer?.hostname;
  }
  get localPort() {
    return this[kRequest][kServer].nativeServer?.port;
  }
  get localFamily() {
    return this.localAddress?.includes(":") ? "IPv6" : "IPv4";
  }
  get _httpMessage() {
    return this[kRequest][kResponse];
  }
  get authorized() {
    return false;
  }
  get alpnProtocol() {
    return false;
  }
  address(): AddressInfo {
    return {
      address: this.localAddress ?? "",
      port: this.localPort ?? 0,
      family: this.localFamily,
    };
  }
  setTimeout(timeout: number, callback?: () => void) {
    this.timeout = timeout;
    if (callback) this.once("timeout", callback);
    return this;
  }
  setNoDelay() {
    return this;
  }
  setKeepAlive() {
    return this;
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
  // Direct socket I/O bypasses HTTP; it is not available on this transport.
  write(_chunk: unknown, encoding?: unknown, callback?: unknown) {
    const cb = typeof encoding === "function" ? encoding : callback;
    if (typeof cb === "function") queueMicrotask(() => cb());
    return true;
  }
  end(chunk?: unknown, encoding?: unknown, callback?: unknown) {
    const cb =
      typeof chunk === "function"
        ? chunk
        : typeof encoding === "function"
          ? encoding
          : callback;
    if (typeof cb === "function") queueMicrotask(() => cb());
    return this;
  }
  destroy(error?: Error) {
    if (this.destroyed) return this;
    this.destroyed = true;
    abortRequest(this[kRequest], error);
    return this;
  }
  destroySoon() {
    return this.destroy();
  }
  getPeerCertificate() {
    return null;
  }
}

/* ------------------------------------------------------------------------ */
/* Requests                                                                 */
/* ------------------------------------------------------------------------ */

// Watches the connection once something cares (a 'close' listener, the
// socket facade, a streamed body): Bun aborts the native signal when the
// client leaves. A client gone by then is reported as well, on the next
// turn, so that the listener being attached sees it
function armAbort(req: any) {
  if (req[kState] & R_ARMED) return;
  req[kState] |= R_ARMED;
  const signal: AbortSignal = req[NATIVE_REQUEST].signal;
  if (signal.aborted) {
    queueMicrotask(() => onAbort(req));
  } else {
    signal.addEventListener("abort", () => onAbort(req), { once: true });
  }
}

function onAbort(req: any) {
  if (!req[kResponse].finished) abortRequest(req);
}

// The connection went away under a request: as Node on a socket close,
// 'aborted' on a request whose stream was not read to its end, then 'close'
// without 'finish' on the response, then 'close' on the request
function abortRequest(req: any, error?: Error) {
  const res = req[kResponse];
  if (res.destroyed || res[kState] & S_CLOSED) return;
  if (
    !(req[kState] & R_ABORTED) &&
    !req.destroyed &&
    !(req.readableEnded && req.complete)
  ) {
    req[kState] |= R_ABORTED;
    req.emit("aborted");
  }
  res.destroy(error);
}

// Something is reading a body that is still coming in
function consuming(req: any) {
  const state = req[kState];
  if (state & R_BODY_DONE) return false;
  if (state & R_READING || req[kReader] !== undefined) return true;
  if (!(state & R_STREAM)) return false;
  const rs = req._readableState;
  return rs.flowing === true || rs.reading || req.listenerCount("readable") > 0;
}

// The response is done and nothing consumed the body: as Node's req._dump(),
// the body (which Bun drops) counts as received, 'end' fires and the request
// is destroyed
function dumpRequest(req: any) {
  req[kState] = (req[kState] | R_DUMPED | R_BODY_DONE) & ~R_BODY_PENDING;
  if (!(req[kState] & R_STREAM)) {
    // Nothing ever used the stream, so nothing listens for its events: it
    // ends and closes in its flags
    req[kState] |= R_SETTLED;
    return;
  }
  const rs = req._readableState;
  if (!rs.endEmitted) {
    if (rs.length !== 0 || rs.reading) {
      // Buffered chunks flow out first; the stream destroys itself after 'end'
      req.resume();
      return;
    }
    rs.ended = true;
    rs.endEmitted = true;
    req.emit("end");
  }
  req.destroy();
}

function toBuffer(bytes: Uint8Array) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// The Node stream of a request is built the first time something uses it.
// Most requests are answered without their stream being touched, and
// building one, then ending and destroying it, is a large share of the cost
// of a request. Its lifecycle is kept in flags until then.
function streamOf(req: any) {
  req[kState] |= R_STREAM;
  Readable.call(req, READABLE_OPTIONS);
  const rs = req._readableState;
  const state = req[kState];
  if (state & (R_ENDED | R_SETTLED)) {
    rs.ended = true;
    rs.endEmitted = true;
    if (state & R_SETTLED) {
      rs.destroyed = true;
      rs.closed = true;
      rs.closeEmitted = true;
    }
  }
  return rs;
}

// Called on the requests and responses, with call()
/* eslint-disable @typescript-eslint/unbound-method */
const superOn = Readable.prototype.on;
const superPrepend = IncomingMessage.prototype.prependListener;
const streamEventNames = Stream.prototype.eventNames;
/* eslint-enable @typescript-eslint/unbound-method */

// The listeners of the requests and responses are created with the first
// one, which Stream's eventNames() does not expect
function eventNames(this: any) {
  return this._events === undefined ? [] : streamEventNames.call(this);
}

const requestMembers = members({
  eventNames,
  // Reached through the prototype as well, which has no stream
  get _readableState() {
    return this[NATIVE_REQUEST] === undefined ? undefined : streamOf(this);
  },
  set _readableState(value: any) {
    Object.defineProperty(this, "_readableState", {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  },
  // As Readable's, without building the stream to answer
  get destroyed() {
    return this[kState] & R_STREAM
      ? this._readableState.destroyed
      : (this[kState] & R_SETTLED) !== 0;
  },
  set destroyed(value: boolean) {
    this._readableState.destroyed = value;
  },
  get readableEnded() {
    return this[kState] & R_STREAM
      ? this._readableState.endEmitted
      : (this[kState] & (R_ENDED | R_SETTLED)) !== 0;
  },
  get headers() {
    return (this[kHeaders] ??= this[NATIVE_REQUEST].headers.toJSON());
  },
  set headers(value: any) {
    this[kHeaders] = value;
  },
  get rawHeaders() {
    let raw = this[kRawHeaders];
    if (raw === undefined) {
      raw = this[kRawHeaders] = [];
      for (const [name, value] of this[NATIVE_REQUEST].headers) {
        raw.push(name, value);
      }
    }
    return raw;
  },
  set rawHeaders(value: any) {
    this[kRawHeaders] = value;
  },
  get headersDistinct() {
    const distinct: Record<string, string[]> = Object.create(null);
    const raw = this.rawHeaders;
    for (let i = 0; i < raw.length; i += 2) {
      (distinct[raw[i]] ??= []).push(raw[i + 1]);
    }
    return distinct;
  },
  get socket() {
    let socket = this[kSocket];
    if (socket === undefined) {
      socket = this[kSocket] = new ConnectionFacade(this);
      armAbort(this);
    }
    return socket;
  },
  set socket(value: any) {
    this[kSocket] = value;
  },
  get connection() {
    return this.socket;
  },
  get client() {
    return this.socket;
  },
  get aborted() {
    return (this[kState] & R_ABORTED) !== 0;
  },
  get signal() {
    let controller = this[kSignal];
    if (controller === undefined) {
      controller = this[kSignal] = new AbortController();
      if (this.destroyed) {
        controller.abort();
      } else {
        this.once("close", () => controller.abort());
      }
    }
    return controller.signal;
  },
  setTimeout(_timeout: number, callback?: () => void) {
    if (callback) this.once("timeout", callback);
    return this;
  },
  on(event: string | symbol, listener: (...args: any[]) => void) {
    if (event === "close" || event === "aborted" || event === "error") {
      armAbort(this);
    }
    return superOn.call(this, event, listener);
  },
  prependListener(event: string | symbol, listener: (...args: any[]) => void) {
    if (event === "close" || event === "aborted" || event === "error") {
      armAbort(this);
    }
    return superPrepend.call(this, event, listener);
  },
  // Reading Request.body materializes the body stream, a cost the parser
  // and the common replies never need to pay: the body's state is kept in
  // flags, and the native body is only consulted when a caller asks
  get complete() {
    const state = this[kState];
    if (state & R_BODY_DONE) return true;
    if (state & R_BODY_PENDING) return false;
    if (this[NATIVE_REQUEST].body === null) {
      this[kState] |= R_BODY_DONE;
      return true;
    }
    this[kState] |= R_BODY_PENDING;
    return false;
  },
  set complete(value: boolean) {
    if (value) {
      this[kState] = (this[kState] | R_BODY_DONE) & ~R_BODY_PENDING;
    } else {
      this[kState] = (this[kState] | R_BODY_PENDING) & ~R_BODY_DONE;
    }
  },
  [REQUEST_HEADER](name: string) {
    const headers = this[kHeaders];
    if (headers != null) return headers[name];
    return this[NATIVE_REQUEST].headers.get(name) ?? undefined;
  },
  [READ_NATIVE_BODY](
    asText: boolean,
    onBody: (body: any) => void,
    onError: (error: Error) => void,
  ) {
    if (
      this[kState] & (R_READING | R_BODY_DONE) ||
      this[kReader] !== undefined ||
      (this[kState] & R_STREAM && this._readableState.flowing !== null)
    ) {
      return false;
    }
    this[kState] |= R_READING;
    const native: Request = this[NATIVE_REQUEST];
    const settle = (body: any) => {
      this[kState] =
        (this[kState] & ~(R_READING | R_BODY_PENDING)) | R_BODY_DONE;
      if (this.destroyed) {
        onBody(body);
        return;
      }
      if (!(this[kState] & R_STREAM)) {
        // Nothing uses the stream: it ends with the body, before the body is
        // handed over, and closes after it, as below
        this[kState] |= R_ENDED;
        onBody(body);
        if (!(this[kState] & R_STREAM)) {
          this[kState] |= R_SETTLED;
        } else if (!this.destroyed) {
          this.destroy();
        }
        return;
      }
      const state = this._readableState;
      if (
        state.flowing === true ||
        state.reading ||
        this.listenerCount("readable") > 0
      ) {
        // A consumer joined while the body was read: it gets the body
        // through the stream as well, which destroys itself after 'end'
        this.push(body);
        this.push(null);
        onBody(body);
        return;
      }
      // The Node stream ends with the body, before it is handed over, so
      // that readableEnded holds and 'end' has fired by then. Nothing is
      // consuming the stream, so its end is recorded in place of the
      // push(null) and the two ticks it would take
      state.ended = true;
      state.endEmitted = true;
      this.emit("end");
      onBody(body);
      // As Node: a request is destroyed once its body has been consumed
      if (!this.destroyed) this.destroy();
    };
    const fail = (error: Error) => {
      this[kState] &= ~R_READING;
      this.destroy(error);
      onError(error);
    };
    if (asText) {
      native.text().then(settle, fail);
    } else {
      native.bytes().then((bytes) => settle(toBuffer(bytes)), fail);
    }
    return true;
  },
  _read() {
    const state = this[kState];
    if (state & R_READING) return;
    if (state & R_BODY_DONE) {
      this.push(null);
      return;
    }
    const native: Request = this[NATIVE_REQUEST];
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined =
      this[kReader];
    if (reader === undefined) {
      // A body of known, small length is read in one native call; a chunked
      // or large one streams through a reader
      const headers = this[kHeaders];
      const contentLength =
        headers !== undefined
          ? headers["content-length"]
          : native.headers.get("content-length");
      if (contentLength != null && Number(contentLength) <= SMALL_BODY) {
        this[kState] |= R_READING;
        native.bytes().then(
          (bytes) => {
            this[kState] =
              (this[kState] & ~(R_READING | R_BODY_PENDING)) | R_BODY_DONE;
            if (this.destroyed) return;
            if (bytes.byteLength > 0) this.push(toBuffer(bytes));
            this.push(null);
          },
          (error) => {
            this[kState] &= ~R_READING;
            this.destroy(error);
          },
        );
        return;
      }
      const body = native.body;
      if (body === null) {
        this[kState] = (this[kState] & ~R_BODY_PENDING) | R_BODY_DONE;
        this.push(null);
        return;
      }
      this[kState] |= R_BODY_PENDING;
      reader = this[kReader] = body.getReader();
    }
    this[kState] |= R_READING;
    reader.read().then(
      ({ done, value }) => {
        this[kState] &= ~R_READING;
        if (this.destroyed) return;
        if (done) {
          this[kState] = (this[kState] & ~R_BODY_PENDING) | R_BODY_DONE;
          this.push(null);
        } else {
          this.push(toBuffer(value));
        }
      },
      (error) => {
        this[kState] &= ~R_READING;
        this.destroy(error);
      },
    );
  },
  _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    const state = this[kState];
    let aborted = (state & R_ABORTED) !== 0;
    if (
      !(state & (R_DUMPED | R_ABORTED)) &&
      !(this._readableState.endEmitted && this.complete)
    ) {
      this[kState] |= R_ABORTED;
      aborted = true;
      this.emit("aborted");
    }
    const reader = this[kReader];
    if (reader !== undefined) {
      this[kReader] = undefined;
      reader.cancel().catch(noop);
    }
    // As Node: a request destroyed before its body was received takes the
    // connection, and so its response, down with it
    const res = this[kResponse];
    if (aborted && res !== undefined && !res.finished && !res.destroyed) {
      res.destroy(error ?? undefined);
    }
    // As Node's IncomingMessage: an error that nothing listens for is dropped
    // rather than thrown
    callback(error !== null && this.listenerCount("error") > 0 ? error : null);
  },
  _dump() {
    this.resume();
  },
});
// Parser state Node's IncomingMessage constructor sets; shared defaults here
const data = (value: unknown): PropertyDescriptor => ({
  value,
  writable: true,
  configurable: true,
});
Object.assign(requestMembers, {
  addListener: requestMembers.on,
  rawTrailers: data(EMPTY_ARRAY),
  httpVersion: data("1.1"),
  httpVersionMajor: data(1),
  httpVersionMinor: data(1),
  upgrade: data(false),
  joinDuplicateHeaders: data(false),
  statusCode: data(null),
  statusMessage: data(null),
  _consuming: data(false),
  _dumped: data(false),
});

/**
 * The request class of a server: `Base.prototype` (the adapter's request
 * class, a Node `IncomingMessage`) with the members that read Node's parser
 * state replaced by ones reading the native `Request`. Instances are
 * `Readable`s whose stream state is built on first use; the `IncomingMessage`
 * constructor never runs.
 */
function createRequestClass(Base: typeof IncomingMessage) {
  function FetchRequest(this: any, native: Request, server: BunHttpServer) {
    // The Readable constructor runs with the stream (see streamOf())
    this._events = undefined;
    this[NATIVE_REQUEST] = native;
    this[kServer] = server;
    this[kResponse] = undefined;
    this[kHeaders] = undefined;
    this[kRawHeaders] = undefined;
    this[kSocket] = undefined;
    this[kReader] = undefined;
    this[kSignal] = undefined;
    this[kState] = 0;
    // Bun keeps the request target in Request.url. Slicing it (rather than
    // parsing it with URL()) keeps the query string and encoding as received.
    const url = native.url;
    const start = url.indexOf("/", url.indexOf("://") + 3);
    this.url = start === -1 ? "/" : url.slice(start);
    this.method = native.method;
    // Set by the router on every request: initialized here so that every
    // request has the same shape
    this.originalUrl = undefined;
    this.baseUrl = undefined;
    this.params = undefined;
    this.body = undefined;
  }
  FetchRequest.prototype = Object.create(Base.prototype, requestMembers);
  FetchRequest.prototype.constructor = FetchRequest;
  return FetchRequest as unknown as new (
    native: Request,
    server: BunHttpServer,
  ) => IncomingMessage;
}

/* ------------------------------------------------------------------------ */
/* Responses                                                                */
/* ------------------------------------------------------------------------ */

// The headers of a response as Response() takes them: the store, pairs when a
// header has several values, or a shared Headers (see typeHeaders). Bun sends
// the length of a string or bytes body whatever its Content-Length says, and
// each header costs Response() a parse: `sized` leaves that one out.
function headersInit(res: any, sized: boolean) {
  const store: HeaderStore | null = res[kHeaders];
  if (store === null) return undefined;
  if (!(res[kState] & S_ARRAY_HEADER)) {
    let type: unknown;
    let others = false;
    for (const name in store) {
      if (name === "content-type") {
        type = store[name];
      } else if (!sized || name !== "content-length") {
        others = true;
        break;
      }
    }
    if (!others && typeof type === "string") return contentTypeHeaders(type);
    if (!sized || store["content-length"] === undefined) return store;
    const init = new HeaderInit();
    for (const name in store) {
      if (name !== "content-length") init[name] = store[name];
    }
    return init;
  }
  const pairs: [string, string][] = [];
  for (const name in store) {
    if (sized && name === "content-length") continue;
    const value = store[name];
    if (Array.isArray(value)) {
      for (const entry of value) pairs.push([name, String(entry)]);
    } else {
      pairs.push([name, String(value)]);
    }
  }
  return pairs;
}

function responseInit(res: any, sized: boolean) {
  const headers = headersInit(res, sized);
  const statusText = res.statusMessage;
  if (statusText) {
    RESPONSE_INIT_TEXT.status = res.statusCode;
    RESPONSE_INIT_TEXT.statusText = statusText;
    RESPONSE_INIT_TEXT.headers = headers;
    return RESPONSE_INIT_TEXT;
  }
  if (res.statusCode === 200) {
    RESPONSE_INIT_OK.headers = headers;
    return RESPONSE_INIT_OK;
  }
  RESPONSE_INIT.status = res.statusCode;
  RESPONSE_INIT.headers = headers;
  return RESPONSE_INIT;
}

// A reply that held Bun's idle timer off (see handle()) is complete: the timer
// is armed again for the keep-alive wait after it, while Bun still has the
// request (afterwards, Bun ignores it)
function rearmIdle(res: any) {
  if (!(res[kState] & S_IDLE_OFF)) return;
  const server: BunHttpServer = res[kServer];
  server.nativeServer!.timeout(res.req[NATIVE_REQUEST], server.idleTimeout());
}

function deliver(res: any, response: Response) {
  res[kNative] = response;
  const resolve = res[kResolve];
  if (resolve !== undefined) {
    res[kResolve] = undefined;
    resolve(response);
  }
}

// Calls the write() callbacks of the chunks Bun has taken: those handed to
// the body within its first `taken` bytes
function settleWrites(stream: StreamState, taken: number) {
  const pending = stream.pending!;
  let count = 0;
  while (count < pending.length && pending[count].at <= taken) count++;
  if (count === 0) return;
  const ready = pending.splice(0, count);
  if (pending.length === 0) stream.pending = undefined;
  try {
    for (const { callback } of ready) callback();
  } catch (error) {
    // Uncaught, as a throwing write callback is under Node
    queueMicrotask(() => {
      throw error;
    });
  }
}

function emitFinish(res: any, callback: (() => void) | undefined) {
  if (res.destroyed) return;
  const stream: StreamState | undefined = res[kStream];
  if (stream?.pending !== undefined) settleWrites(stream, Infinity);
  res[kState] |= S_FINISH_EMITTED;
  res.emit("finish");
  callback?.();
  closeResponse(res, false);
}

// The last event of a response: 'close', then that of its socket facade and
// of its request, which Node also closes once the response is done
function closeResponse(res: any, hadError: boolean) {
  if (res[kState] & S_CLOSED) return;
  res[kState] |= S_CLOSED;
  res._closed = true;
  res.emit("close");
  const req = res.req;
  const socket = req[kSocket];
  if (socket !== undefined) {
    socket.destroyed = true;
    socket.readable = false;
    socket.writable = false;
    socket.emit("close", hadError);
  }
  if (!req.destroyed) {
    // Bun stops feeding a body once the response is out: a reader still
    // waiting for it is aborted, as it is when the connection is gone
    if (hadError || consuming(req)) {
      req.destroy(abortError());
    } else {
      dumpRequest(req);
    }
  }
  res[kServer].requestDone(res);
}

function startStream(res: any): StreamState {
  const stream: StreamState = {
    controller: undefined,
    needDrain: false,
    remaining: Number(res[kHeaders]?.["content-length"]),
    ended: false,
    done: false,
    allowBody: res._hasBody && !hasNullBody(res.statusCode),
    callback: undefined,
    written: 0,
    pending: undefined,
  };
  res[kStream] = stream;
  armAbort(res.req);
  let body: ReadableStream | null = null;
  if (stream.allowBody) {
    // A pull-based body: Bun reads it as the socket drains, so that the
    // queue, and 'drain', follow the client. (A "direct" stream's flush()
    // never reports backpressure: a slow client would buffer the whole body.)
    body = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          stream.controller = controller;
        },
        pull: (controller) => {
          // Bun pulls as its writer takes chunks: what it has taken is the
          // body minus what is still queued
          if (stream.pending !== undefined) {
            settleWrites(
              stream,
              stream.written -
                HIGH_WATER_MARK +
                (controller.desiredSize ?? HIGH_WATER_MARK),
            );
          }
          if (stream.ended) {
            // The queue is empty: the body ends, and so does the response
            if (!stream.done && controller.desiredSize === HIGH_WATER_MARK) {
              stream.done = true;
              rearmIdle(res);
              controller.close();
              const callback = stream.callback;
              stream.callback = undefined;
              queueMicrotask(() => emitFinish(res, callback));
            }
          } else if (stream.needDrain && !res.destroyed) {
            stream.needDrain = false;
            res.emit("drain");
          }
        },
        cancel: (reason: unknown) => {
          res.destroy(reason instanceof Error ? reason : undefined);
        },
      },
      STREAM_STRATEGY,
    );
  } else {
    // A reply without a body is complete as it is delivered
    rearmIdle(res);
  }
  deliver(res, new Response(body, responseInit(res, false)));
  return stream;
}

// Ends the body. With chunks still queued, the body is closed by the pull
// that finds the queue empty, so that 'finish' means Bun's writer has taken
// every chunk (as Node's means the kernel has), not just that they were
// handed to the response. A body already closed by its declared length
// finishes at once: Bun owns its chunks from there.
function finishStream(res: any, stream: StreamState, callback: any) {
  stream.ended = true;
  if (stream.allowBody && !stream.done) {
    const controller = stream.controller!;
    if (controller.desiredSize !== HIGH_WATER_MARK) {
      stream.callback = callback;
      return;
    }
    stream.done = true;
    rearmIdle(res);
    controller.close();
  }
  queueMicrotask(() => emitFinish(res, callback));
}

const responseMembers = members({
  eventNames,
  get headersSent() {
    return this._header !== null;
  },
  set headersSent(value: boolean) {
    this._header = value ? statusLine(this.statusCode) : null;
  },
  get socket() {
    return this.req.socket;
  },
  set socket(value: any) {
    this.req.socket = value;
  },
  get connection() {
    return this.req.socket;
  },
  get writableEnded() {
    return this.finished;
  },
  get writableFinished() {
    return (this[kState] & S_FINISH_EMITTED) !== 0;
  },
  get writableNeedDrain() {
    return this[kStream]?.needDrain === true;
  },
  get writableLength() {
    const stream: StreamState | undefined = this[kStream];
    if (stream === undefined || stream.done) return 0;
    return (
      HIGH_WATER_MARK - (stream.controller?.desiredSize ?? HIGH_WATER_MARK)
    );
  },
  get writableHighWaterMark() {
    return HIGH_WATER_MARK;
  },
  get writableObjectMode() {
    return false;
  },
  get writableCorked() {
    return 0;
  },
  get closed() {
    return this._closed;
  },
  get errored() {
    return this[kError];
  },
  get _headers() {
    return this.getHeaders();
  },
  // eslint-disable-next-line @typescript-eslint/unbound-method -- a member of the responses
  emit: EventEmitter.prototype.emit,
  on(event: string | symbol, listener: (...args: any[]) => void) {
    if (event === "close" || event === "error" || event === "drain") {
      armAbort(this.req);
    }
    return EventEmitter.prototype.on.call(this, event, listener);
  },
  prependListener(event: string | symbol, listener: (...args: any[]) => void) {
    if (event === "close" || event === "error" || event === "drain") {
      armAbort(this.req);
    }
    return EventEmitter.prototype.prependListener.call(this, event, listener);
  },
  setHeader(name: string, value: unknown) {
    if (this._header !== null) throw headersSentError("set");
    const key = headerKey(name);
    validateHeaderValue(name, value);
    (this[kHeaders] ??= Object.create(null))[key] = value;
    if (Array.isArray(value)) this[kState] |= S_ARRAY_HEADER;
    return this;
  },
  appendHeader(name: string, value: unknown) {
    if (this._header !== null) throw headersSentError("append");
    const key = headerKey(name);
    validateHeaderValue(name, value);
    const store: HeaderStore = (this[kHeaders] ??= Object.create(null));
    const existing = store[key];
    if (existing === undefined) {
      store[key] = value as any;
      if (Array.isArray(value)) this[kState] |= S_ARRAY_HEADER;
      return this;
    }
    const values = Array.isArray(existing) ? existing : [String(existing)];
    if (Array.isArray(value)) {
      for (const entry of value) values.push(entry);
    } else {
      values.push(value as string);
    }
    store[key] = values;
    this[kState] |= S_ARRAY_HEADER;
    return this;
  },
  setHeaders(headers: Headers | Map<string, unknown>) {
    if (this._header !== null) throw headersSentError("set");
    if (
      !headers ||
      (!(headers instanceof Headers) && !(headers instanceof Map))
    ) {
      throw errorWithCode(
        'The "headers" argument must be an instance of Headers or Map',
        "ERR_INVALID_ARG_TYPE",
        TypeError,
      );
    }
    for (const [name, value] of headers) {
      this.setHeader(name, value);
    }
    return this;
  },
  getHeader(name: string) {
    const store = this[kHeaders];
    return store === null ? undefined : store[String(name).toLowerCase()];
  },
  getHeaders() {
    const headers = Object.create(null);
    const store = this[kHeaders];
    if (store !== null) {
      for (const key in store) headers[key] = store[key];
    }
    return headers;
  },
  getHeaderNames() {
    return this[kHeaders] === null ? [] : Object.keys(this[kHeaders]);
  },
  getRawHeaderNames() {
    return this.getHeaderNames();
  },
  hasHeader(name: string) {
    const store = this[kHeaders];
    return store !== null && store[String(name).toLowerCase()] !== undefined;
  },
  removeHeader(name: string) {
    if (this._header !== null) throw headersSentError("remove");
    const store = this[kHeaders];
    if (store !== null) delete store[String(name).toLowerCase()];
  },
  writeHead(
    statusCode: number,
    reason?: string | Record<string, unknown> | readonly unknown[],
    headers?: Record<string, unknown> | readonly unknown[],
  ) {
    if (this._header !== null) throw headersSentError("write");
    const code = Number(statusCode);
    if (!Number.isInteger(code) || code < 100 || code > 999) {
      throw errorWithCode(
        `Invalid status code: ${statusCode}`,
        "ERR_HTTP_INVALID_STATUS_CODE",
        RangeError,
      );
    }
    if (code < 200 || code > 599) {
      // The native Response only carries final statuses
      throw errorWithCode(
        `Invalid status code: ${code} (Bun.serve() responses are 200 to 599)`,
        "ERR_HTTP_INVALID_STATUS_CODE",
        RangeError,
      );
    }
    this.statusCode = code;
    if (typeof reason === "string") {
      this.statusMessage = reason;
    } else {
      headers ??= reason;
    }
    if (headers) {
      if (Array.isArray(headers)) {
        if (headers.length % 2 !== 0) {
          throw errorWithCode(
            "The argument 'headers' is invalid.",
            "ERR_INVALID_ARG_VALUE",
            TypeError,
          );
        }
        // As Node: the names given replace what was set before, and their
        // explicit duplicates are kept
        for (let i = 0; i < headers.length; i += 2) {
          this.removeHeader(String(headers[i]));
        }
        for (let i = 0; i < headers.length; i += 2) {
          const name = headers[i];
          if (name) this.appendHeader(String(name), headers[i + 1]);
        }
      } else {
        for (const name in headers as Record<string, unknown>) {
          this.setHeader(name, (headers as Record<string, unknown>)[name]);
        }
      }
    }
    if (code === 204 || code === 304) this._hasBody = false;
    this._header = statusLine(code);
    return this;
  },
  _implicitHeader() {
    this.writeHead(this.statusCode);
  },
  flushHeaders() {
    if (this.finished || this.destroyed) return;
    if (this._header === null) this._implicitHeader();
    if (this[kStream] === undefined) startStream(this);
  },
  write(chunk: any, encoding?: any, callback?: any): boolean {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    if (this.finished || this.destroyed) {
      const error = errorWithCode(
        "write after end",
        "ERR_STREAM_WRITE_AFTER_END",
      );
      queueMicrotask(() => {
        callback?.(error);
        if (this.listenerCount("error") > 0) this.emit("error", error);
      });
      return false;
    }
    if (typeof chunk !== "string" && !ArrayBuffer.isView(chunk)) {
      throw errorWithCode(
        'The "chunk" argument must be of type string or an instance of Buffer or Uint8Array',
        "ERR_INVALID_ARG_TYPE",
        TypeError,
      );
    }
    if (this._header === null) this._implicitHeader();
    const stream: StreamState = this[kStream] ?? startStream(this);
    let needDrain = false;
    if (stream.allowBody && !stream.done) {
      const bytes: Uint8Array =
        typeof chunk === "string"
          ? Buffer.from(chunk, encoding)
          : (chunk as Uint8Array);
      const controller = stream.controller!;
      const length = bytes.byteLength;
      if (length > 0) controller.enqueue(bytes);
      stream.written += length;
      // Bun sends an explicit Content-Length only when the body is complete
      // by the time it reads it, so a body that arrives in one turn (a file
      // of one chunk, for instance) is closed as soon as its last byte is in
      if ((stream.remaining -= length) <= 0) {
        stream.done = true;
        rearmIdle(this);
        controller.close();
        // Bun owns the chunks from here: their callbacks are due
        if (callback) (stream.pending ??= []).push({ at: 0, callback });
        if (stream.pending !== undefined) {
          queueMicrotask(() => {
            if (stream.pending !== undefined) settleWrites(stream, Infinity);
          });
        }
        return true;
      }
      if (callback && length > 0) {
        // As Node's, the callback follows the chunk out: once Bun's writer
        // has taken it (see pull())
        (stream.pending ??= []).push({ at: stream.written, callback });
        callback = undefined;
      }
      needDrain = (controller.desiredSize ?? 1) <= 0;
    }
    if (callback) queueMicrotask(callback);
    if (needDrain) {
      stream.needDrain = true;
      return false;
    }
    return true;
  },
  end(chunk?: any, encoding?: any, callback?: any) {
    if (typeof chunk === "function") {
      callback = chunk;
      chunk = undefined;
      encoding = undefined;
    } else if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    if (this.finished) {
      if (callback) queueMicrotask(callback);
      return this;
    }
    if (this.destroyed) return this;
    if (
      chunk !== undefined &&
      chunk !== null &&
      typeof chunk !== "string" &&
      !ArrayBuffer.isView(chunk)
    ) {
      throw errorWithCode(
        'The "chunk" argument must be of type string or an instance of Buffer or Uint8Array',
        "ERR_INVALID_ARG_TYPE",
        TypeError,
      );
    }
    if (this._header === null) this._implicitHeader();
    const stream: StreamState | undefined = this[kStream];
    if (stream !== undefined) {
      if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
      this.finished = true;
      finishStream(this, stream, callback);
      return this;
    }
    this.finished = true;
    let body: string | ArrayBufferView | ReadableStream | null = null;
    // Whether Bun sends the body's own length (see headersInit())
    let sized = false;
    // A HEAD or bodiless-status response carries no body. Bun keeps an
    // explicit Content-Length on a HEAD response (and sends 0 without one)
    if (
      chunk !== undefined &&
      chunk !== null &&
      chunk.length !== 0 &&
      this._hasBody &&
      !hasNullBody(this.statusCode)
    ) {
      const payload: string | ArrayBufferView =
        typeof chunk === "string" &&
        encoding !== undefined &&
        encoding !== "utf8" &&
        encoding !== "utf-8"
          ? Buffer.from(chunk, encoding)
          : chunk;
      const store = this[kHeaders];
      if (store === null || store["content-type"] === undefined) {
        // Response(string | bytes) makes Bun infer a Content-Type, which a
        // raw ServerResponse.end() does not send. A closed stream keeps
        // that contract (the common replies all set their type).
        const bytes =
          typeof payload === "string" ? Buffer.from(payload) : payload;
        body = new ReadableStream(
          {
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          },
          ONE_BODY_STRATEGY,
        );
      } else {
        body = payload;
        sized = true;
      }
    }
    rearmIdle(this);
    deliver(this, new Response(body as BodyInit, responseInit(this, sized)));
    queueMicrotask(() => emitFinish(this, callback));
    return this;
  },
  destroy(error?: Error) {
    if (this.destroyed) return this;
    this.destroyed = true;
    this[kError] = error ?? null;
    const stream: StreamState | undefined = this[kStream];
    if (stream !== undefined) {
      if (stream.allowBody && !stream.done) {
        // Terminates the connection mid-body, as a destroyed socket does
        stream.done = true;
        stream.controller!.error(error ?? abortError());
      }
      const pending = stream.pending;
      if (pending !== undefined) {
        stream.pending = undefined;
        const destroyed = errorWithCode(
          "Cannot call write after a stream was destroyed",
          "ERR_STREAM_DESTROYED",
        );
        queueMicrotask(() => {
          for (const { callback } of pending) callback(destroyed);
        });
      }
    } else if (this[kNative] === undefined) {
      // A rejected fetch-handler promise becomes a 500 in Bun. An errored
      // response body instead terminates this request's TCP connection, as
      // ServerResponse.destroy() does, without stopping other requests.
      const reason = error ?? abortError();
      deliver(
        this,
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(reason);
            },
          }),
        ),
      );
    }
    // As Node: the error is reported by res.errored, not emitted
    queueMicrotask(() => closeResponse(this, true));
    return this;
  },
  cork() {},
  uncork() {},
  setTimeout(_timeout: number, callback?: () => void) {
    if (callback) this.once("timeout", callback);
    return this;
  },
  // Informational responses and trailers are not carried by Response
  writeContinue(_callback?: () => void) {},
  writeProcessing(_callback?: () => void) {},
  writeEarlyHints(_hints: unknown, _callback?: () => void) {},
  addTrailers(_headers: unknown) {},
  assignSocket() {},
  detachSocket() {},
  _send(data: any, encoding?: any, callback?: any) {
    return this.write(data, encoding, callback);
  },
  _writeRaw(data: any, encoding?: any, callback?: any) {
    return this.write(data, encoding, callback);
  },
});
// Output state Node's ServerResponse constructor sets; shared defaults here
Object.assign(responseMembers, {
  addListener: responseMembers.on,
  writable: data(true),
  chunkedEncoding: data(false),
  shouldKeepAlive: data(true),
  useChunkedEncodingByDefault: data(true),
  sendDate: data(true),
  strictContentLength: data(false),
  _contentLength: data(null),
  _trailer: data(""),
  _last: data(false),
  _headerSent: data(false),
  _sent100: data(false),
  _expect_continue: data(false),
  _defaultKeepAlive: data(true),
  _removedConnection: data(false),
  _removedContLen: data(false),
  _removedTE: data(false),
  _keepAliveTimeout: data(0),
  maxRequestsOnConnectionReached: data(false),
  outputSize: data(0),
});

/**
 * The response class of a server: `Base.prototype` (the adapter's response
 * class, a Node `ServerResponse`) with the members that render to Node's
 * socket replaced by ones building the native `Response`. Instances are plain
 * event emitters; the `ServerResponse` constructor never runs.
 */
function createResponseClass(Base: typeof ServerResponse) {
  function FetchResponse(this: any, req: any, server: BunHttpServer) {
    // EventEmitter's state, its listeners created with the first one
    this._events = undefined;
    this._eventsCount = 0;
    this._maxListeners = undefined;
    this.req = req;
    this[kServer] = server;
    this[kResolve] = undefined;
    this[kNative] = undefined;
    this[kHeaders] = null;
    this[kStream] = undefined;
    this[kError] = null;
    this[kState] = 0;
    this[kSlot] = -1;
    this.statusCode = 200;
    this.statusMessage = undefined;
    this.finished = false;
    this.destroyed = false;
    this._header = null;
    this._closed = false;
    this._hasBody = req.method !== "HEAD";
  }
  FetchResponse.prototype = Object.create(Base.prototype, responseMembers);
  FetchResponse.prototype.constructor = FetchResponse;
  return FetchResponse as unknown as new (
    req: IncomingMessage,
    server: BunHttpServer,
  ) => ServerResponse;
}

/* ------------------------------------------------------------------------ */
/* Server                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * The Bun.serve() idle timeout, in seconds, that keeps an idle keep-alive
 * connection open at least Node's keepAliveTimeout plus its buffer (in ms).
 * Bun closes a socket idle for s seconds on the ((s + 3) >> 2)th tick of its
 * four-second timer, the first of which may come at once: one tick more than
 * the wait needs. 0 (never closed) when keepAliveTimeout is 0, as in Node, or
 * when the wait is longer than Bun can count.
 */
export function keepAliveIdleTimeout(keepAliveTimeout: number, buffer: number) {
  if (keepAliveTimeout <= 0) return 0;
  const ticks = Math.ceil((keepAliveTimeout + buffer) / 4000) + 1;
  return ticks > 64 ? 0 : Math.min(255, ticks * 4);
}

// Set while a request handler runs the microtasks of its request
let runningMicrotasks = false;

/** A Nest-compatible lifecycle facade over Bun.serve(), with Node stream handlers. */
export class BunHttpServer extends EventEmitter {
  public nativeServer?: BunNativeServer<unknown>;
  public listening = false;
  public readonly options: BunHttpServerOptions;
  /**
   * The server object applications see (`req.socket.server`): this one, or
   * the TLS facade wrapping it.
   */
  public owner: EventEmitter = this;
  // Node server settings. The keep-alive ones set Bun's idle timeout (see
  // idleTimeout()); the others are accepted for compatibility, as Bun owns
  // the sockets
  public timeout = 0;
  public keepAliveTimeout = 5000;
  public keepAliveTimeoutBuffer = 1000;
  public headersTimeout = 60000;
  public requestTimeout = 300000;
  public maxHeadersCount: number | null = null;
  public maxRequestsPerSocket: number | null = null;
  private readonly listener: Listener;
  private readonly RequestClass: ReturnType<typeof createRequestClass>;
  private readonly ResponseClass: ReturnType<typeof createResponseClass>;
  /**
   * The responses in flight, each at its index in `kSlot`: the last one takes
   * the place of a response that leaves, which costs less than a Set's
   * deletion at this rate.
   */
  private readonly active: any[] = [];
  private closing?: Promise<void>;
  /**
   * While close() drains: the connections that were busy when it was called,
   * by address and port. Node keeps serving those and refuses the others.
   */
  private busy?: Set<string>;
  private draining = 0;
  private unixPath?: string;
  private serveOptions?: Bun.Serve.Options<unknown>;
  /** The idle timeout that listen() gave Bun.serve(), in seconds */
  private servedIdleTimeout = 0;
  private unrefed = false;
  constructor(listener: Listener, options: BunHttpServerOptions = {}) {
    super();
    this.listener = listener;
    this.options = options;
    this.RequestClass = createRequestClass(
      options.requestClass ?? IncomingMessage,
    );
    this.ResponseClass = createResponseClass(
      options.responseClass ?? ServerResponse,
    );
  }
  listen(
    port: number | string | Record<string, any>,
    hostnameOrCallback?: string | (() => void),
    callback?: () => void,
  ): this {
    if (this.listening) {
      throw errorWithCode(
        "Listen method has been called more than once without closing.",
        "ERR_SERVER_ALREADY_LISTEN",
      );
    }
    const config =
      typeof port === "object"
        ? port
        : {
            port,
            host:
              typeof hostnameOrCallback === "string"
                ? hostnameOrCallback
                : undefined,
          };
    const done =
      typeof hostnameOrCallback === "function" ? hostnameOrCallback : callback;
    const unix =
      config.path ??
      (typeof config.port === "string" && !/^\d+$/.test(config.port)
        ? config.port
        : undefined);
    this.unixPath = unix;
    this.servedIdleTimeout = this.idleTimeout();
    try {
      const serveOptions = {
        ...(unix
          ? { unix }
          : {
              port: Number(config.port),
              hostname: config.host ?? config.hostname ?? "0.0.0.0",
            }),
        tls: this.options.tls,
        reusePort: false,
        // The body parsers enforce their own per-parser limits. Bun's default
        // 128 MiB cap must not silently replace an explicit larger parser limit.
        maxRequestBodySize:
          this.options.maxRequestBodySize ?? Number.MAX_SAFE_INTEGER,
        idleTimeout: this.servedIdleTimeout,
        development: false,
        // Bun passes the server along with a request it read from a socket,
        // and only the request through server.fetch()
        fetch: (request: Request, server?: unknown) =>
          this.handle(request, server !== undefined),
        error: () => new Response("Internal Server Error", { status: 500 }),
      } as Bun.Serve.Options<unknown>;
      this.nativeServer = Bun.serve(serveOptions);
      // A port of zero is resolved once; listener replacement keeps that port.
      this.serveOptions = (
        unix ? serveOptions : { ...serveOptions, port: this.nativeServer.port! }
      ) as Bun.Serve.Options<unknown>;
      this.listening = true;
      this.closing = undefined;
      this.busy = undefined;
      queueMicrotask(() => {
        this.emit("listening");
        done?.();
      });
    } catch (error) {
      queueMicrotask(() => this.emit("error", error));
    }
    return this;
  }
  private handle(
    request: Request,
    overSocket: boolean,
  ): Response | Promise<Response> {
    if (this.busy !== undefined) {
      // close() was called: as Node, which stops listening at once, a
      // connection that was not busy by then is turned away. The port
      // stays bound until the busy ones are done.
      const ip = this.nativeServer!.requestIP(request);
      if (ip !== null && !this.busy.has(`${ip.address}:${ip.port}`)) {
        return new Response(null, {
          status: 503,
          headers: { connection: "close" },
        });
      }
    }
    const req: any = new this.RequestClass(request, this);
    const res: any = new this.ResponseClass(req, this);
    req[kResponse] = res;
    res[kSlot] = this.active.length;
    this.active.push(res);
    this.emit("request", req, res);
    try {
      this.listener(req, res);
    } catch (error) {
      res.destroy(error);
    }
    // A response produced during dispatch goes straight to Bun. Bun runs the
    // microtasks a request queued once its handler returns: running them
    // now gives Bun the reply of an asynchronous route handler that awaited
    // nothing pending as a Response, which it takes for less than a promise.
    // Not for server.fetch(), whose caller's microtasks would run before it
    // returns, nor within such a run.
    let response = res[kNative];
    if (response === undefined && overSocket && !runningMicrotasks) {
      runningMicrotasks = true;
      drainMicrotasks();
      runningMicrotasks = false;
      response = res[kNative];
    }
    // Bun's idle timer runs while a request is in flight: a reply produced
    // across turns holds it off, as Node times out only idle connections
    if (response !== undefined) {
      if (overSocket) {
        const stream: StreamState | undefined = res[kStream];
        if (stream !== undefined && stream.allowBody && !stream.done) {
          this.holdIdle(request, res);
        } else {
          // A keep-alive setting changed since listen(), which Bun.serve()
          // does not see: the connection waits as the setting says
          const idle = this.idleTimeout();
          if (idle !== this.servedIdleTimeout) {
            this.nativeServer!.timeout(request, idle);
          }
        }
      }
      return response;
    }
    if (overSocket) this.holdIdle(request, res);
    // Otherwise the promise is created only now
    return new Promise<Response>((resolve) => {
      res[kResolve] = resolve;
    });
  }
  private holdIdle(request: Request, res: any) {
    this.nativeServer!.timeout(request, 0);
    res[kState] |= S_IDLE_OFF;
  }
  /** @internal Bun's idle timeout for the keep-alive settings in force */
  idleTimeout() {
    return keepAliveIdleTimeout(
      this.keepAliveTimeout,
      this.keepAliveTimeoutBuffer,
    );
  }
  /** @internal */
  requestDone(res: any) {
    const active = this.active;
    const last = active.pop();
    if (last !== res) {
      active[res[kSlot]] = last;
      last[kSlot] = res[kSlot];
    }
    if (active.length === 0 && this.draining !== 0) this.emit(IDLE);
  }
  address(): AddressInfo | string | null {
    if (!this.nativeServer || !this.listening) return null;
    if (this.unixPath) return this.unixPath;
    const address = this.nativeServer.hostname ?? "0.0.0.0";
    return {
      address,
      family: address.includes(":") ? "IPv6" : "IPv4",
      port: this.nativeServer.port!,
    };
  }
  close(callback?: (error?: Error) => void): this {
    const native = this.nativeServer;
    if (!native) {
      queueMicrotask(() => callback?.());
      return this;
    }
    this.listening = false;
    if (this.closing !== undefined) {
      this.closing.then(
        () => callback?.(),
        (error) => callback?.(error),
      );
      return this;
    }
    const busy = new Set<string>();
    for (const res of this.active) {
      const ip = native.requestIP(res.req[NATIVE_REQUEST]);
      if (ip !== null) busy.add(`${ip.address}:${ip.port}`);
    }
    this.busy = busy;
    this.draining++;
    this.closing = new Promise<void>((resolve, reject) => {
      // As Node: stop accepting at once, close the idle keep-alive
      // connections and resolve once the in-flight responses are done
      const stop = () =>
        Promise.resolve(native.stop(false)).then(
          () => {
            this.draining--;
            this.emit("close");
            resolve();
          },
          (error) => {
            this.draining--;
            reject(error);
          },
        );
      if (this.active.length === 0 && native.pendingRequests === 0) {
        void stop();
        return;
      }
      // Bun's stop() closes a busy keep-alive connection as soon as its
      // reply is done, where Node keeps it open and answers the request its
      // client sends on it next (with return503OnClosing, a 503 that closes
      // it): stop once nothing has been in flight for CLOSE_GRACE_MS, neither
      // a response nor a reply that Bun is still sending.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wait = (ms: number) => {
        clearTimeout(timer);
        timer = setTimeout(settle, ms);
      };
      let grace = CLOSE_GRACE_MS;
      let lastInFlight = performance.now();
      // Each response done starts the wait over
      const idle = () => {
        lastInFlight = performance.now();
        settle();
      };
      // closeAllConnections() left no connection to send a request on
      const forced = () => {
        grace = 0;
        wait(0);
      };
      const settle = () => {
        // A response in flight calls idle() once it is done
        if (this.active.length > 0) return;
        const now = performance.now();
        if (native.pendingRequests > 0) {
          lastInFlight = now;
          wait(1);
          return;
        }
        const left = lastInFlight + grace - now;
        if (left > 0) {
          wait(left);
          return;
        }
        // A timer that closeAllConnections() armed may still be due
        clearTimeout(timer);
        this.off(IDLE, idle);
        this.off(FORCED, forced);
        void stop();
      };
      this.on(IDLE, idle);
      this.on(FORCED, forced);
      settle();
    });
    this.closing.then(
      () => callback?.(),
      (error) => callback?.(error),
    );
    return this;
  }
  closeAllConnections() {
    this.emit(FORCED);
    // A destroyed response leaves the list in a microtask
    for (const res of this.active) res.destroy();
    const native = this.nativeServer;
    if (!native) return;
    // Bun has no operation that closes active sockets while retaining its
    // listener. Rotate the native listener on the same address so that
    // force-closing really terminates every native connection.
    void native.stop(true);
    if (this.listening && this.serveOptions) {
      this.nativeServer = Bun.serve(this.serveOptions);
      if (this.unrefed) this.nativeServer.unref();
    }
  }
  closeIdleConnections() {
    this.nativeServer?.closeIdleConnections?.();
  }
  ref(): this {
    this.unrefed = false;
    this.nativeServer?.ref();
    return this;
  }
  unref(): this {
    this.unrefed = true;
    this.nativeServer?.unref();
    return this;
  }
  setTimeout(timeout?: number, callback?: () => void): this {
    if (typeof timeout === "number") this.timeout = timeout;
    if (callback) this.on("timeout", callback);
    return this;
  }
  getConnections(callback: (error: Error | null, count: number) => void) {
    queueMicrotask(() => callback(null, this.active.length));
    return this;
  }
  [Symbol.asyncDispose]() {
    return new Promise<void>((resolve) => this.close(() => resolve()));
  }
}
