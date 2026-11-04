// find-my-way publishes no types for its URL sanitizer, which the router
// shares with Fastify (see utils.ts)
declare module "find-my-way/lib/url-sanitizer.js" {
  const urlSanitizer: {
    safeDecodeURI(
      path: string,
      useSemicolonDelimiter: boolean,
    ): { path: string; querystring: string; shouldDecodeParam: boolean };
  };
  export default urlSanitizer;
}
