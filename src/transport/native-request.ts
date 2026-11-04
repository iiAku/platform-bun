/** The native `Request` of a request served by `Bun.serve()`. */
export const NATIVE_REQUEST = Symbol("nestjs.bun.nativeRequest");

/**
 * `req[REQUEST_HEADER](name)`: one request header by lower-case name, read
 * from the native headers unless `req.headers` has been built or replaced.
 */
export const REQUEST_HEADER = Symbol("nestjs.bun.requestHeader");

/**
 * `req[READ_NATIVE_BODY](asText, onBody, onError)`: reads the whole body in
 * one native call, ends the request stream and calls `onBody` with the body
 * as a `Buffer`, or decoded as UTF-8 text with `asText`; `onError(error)`
 * when the body cannot be read. Returns `false` without reading when the
 * stream is already in use (a body being read, or read, through the Node
 * stream API).
 */
export const READ_NATIVE_BODY = Symbol("nestjs.bun.readNativeBody");
