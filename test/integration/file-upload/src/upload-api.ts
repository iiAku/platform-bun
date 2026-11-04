import type { NestInterceptor, Type } from '@nestjs/common';
import * as express from '@nestjs/platform-express';
import * as node from '../../../../src/index.js';

/**
 * The part of the upload API both platforms share, by name and signature.
 */
export interface UploadApi {
  FileInterceptor(field: string, options?: any): Type<NestInterceptor>;
  FilesInterceptor(
    field: string,
    maxCount?: number,
    options?: any,
  ): Type<NestInterceptor>;
  FileFieldsInterceptor(
    fields: { name: string; maxCount?: number }[],
    options?: any,
  ): Type<NestInterceptor>;
  AnyFilesInterceptor(options?: any): Type<NestInterceptor>;
  NoFilesInterceptor(options?: any): Type<NestInterceptor>;
  /** Only on Fastify. */
  FileStreamInterceptor?(field: string, options?: any): Type<NestInterceptor>;
  /** `MulterModule` or `MultipartModule`. */
  OptionsModule: { register(options: any): any };
}

export const uploadApis: Record<'express' | 'node', UploadApi> = {
  express: { ...express, OptionsModule: express.MulterModule },
  node: { ...node, OptionsModule: node.MulterModule },
};
