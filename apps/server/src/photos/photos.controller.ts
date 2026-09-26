import { Body, Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import {
  PhotoRenditionParams,
  type PhotoView,
  type PhotoWidth,
  UploadPhotoRequest,
} from '@rp/contracts';
import type { Response } from 'express';
import { authErrors } from '../auth/auth-errors.js';
import { Public, RequireCapability } from '../auth/decorators.js';
import type { AuthenticatedRequest } from '../auth/principal.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { PhotosService } from './photos.service.js';

/** A year: a rendition's bytes never change for its URL. */
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

@Controller('photos')
export class PhotosController {
  constructor(private readonly photos: PhotosService) {}

  @Post()
  @RequireCapability('MENU_MANAGE')
  upload(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(UploadPhotoRequest)) body: UploadPhotoRequest,
  ): Promise<PhotoView> {
    if (request.principal === undefined) throw authErrors.unauthenticated();
    return this.photos.upload(request.principal, body);
  }

  /**
   * Public: an `<img>` cannot send a token, menu photos are public on the QR menu anyway, ids are
   * random UUIDs and the files carry no metadata (see the route's description).
   */
  @Get(':id/:width')
  @Public()
  async rendition(
    @Param(new ZodValidationPipe(PhotoRenditionParams)) { id, width }: PhotoRenditionParams,
    @Res() response: Response,
  ): Promise<void> {
    const file = await this.photos.renditionFile(id, Number(width) as PhotoWidth);
    response.setHeader('Cache-Control', CACHE_CONTROL);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.type('image/webp');
    await new Promise<void>((resolve, reject) => {
      response.sendFile(file, { dotfiles: 'deny', cacheControl: false }, (error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  }
}
