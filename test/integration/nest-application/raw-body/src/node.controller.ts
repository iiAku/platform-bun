import { Controller, Post, type RawBodyRequest, Req } from '@nestjs/common';
import type { NodeRequest } from '../../../../../src/index.js';

@Controller()
export class NodeController {
  @Post()
  getRawBody(@Req() req: RawBodyRequest<NodeRequest>) {
    return {
      parsed: req.body,
      raw: req.rawBody!.toString(),
    };
  }
}
