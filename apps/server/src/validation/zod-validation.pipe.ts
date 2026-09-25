import { Injectable, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

/**
 * Validates a request body, query or param against a contract schema from `@rp/contracts`
 * (SEC-004). A failure throws the ZodError, which ApiExceptionFilter maps to 400 VALIDATION_FAILED.
 *
 * Usage: `@Body(new ZodValidationPipe(SubmitOrderRequest)) body: SubmitOrderRequest`
 */
@Injectable()
export class ZodValidationPipe<Schema extends z.ZodType> implements PipeTransform<
  unknown,
  z.output<Schema>
> {
  constructor(private readonly schema: Schema) {}

  transform(value: unknown): z.output<Schema> {
    return this.schema.parse(value);
  }
}
