import { Injectable, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

/** Validates a body or query against a contract schema (SEC-004); failures become 400. */
@Injectable()
export class ZodPipe<Schema extends z.ZodType> implements PipeTransform<unknown, z.output<Schema>> {
  constructor(private readonly schema: Schema) {}

  transform(value: unknown): z.output<Schema> {
    return this.schema.parse(value);
  }
}
