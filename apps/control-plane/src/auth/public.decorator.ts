import { SetMetadata } from '@nestjs/common';

export const PUBLIC_ROUTE = 'cp:public';

/**
 * Marks an endpoint that needs no signed request (ADR-0012). Every other endpoint is refused
 * without a valid installation signature (deny by default, SEC-003). Say why next to each use.
 */
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);
