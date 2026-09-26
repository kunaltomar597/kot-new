import { Controller, Get, Query, Req } from '@nestjs/common';
import { UpdatesQuery, type UpdatesResponse } from '@rp/contracts/control-plane';
import { type InstallationRequest, installationOf } from '../auth/installation.guard.js';
import { ZodPipe } from '../http/zod.pipe.js';
import { ReleasesService } from './releases.service.js';

@Controller('updates')
export class UpdatesController {
  constructor(private readonly releases: ReleasesService) {}

  // Signed by the installation; it sees its own channel only (UPD-002).
  @Get()
  async updates(
    @Req() request: InstallationRequest,
    @Query(new ZodPipe(UpdatesQuery)) query: UpdatesQuery,
  ): Promise<UpdatesResponse> {
    const { channel } = installationOf(request);
    return {
      channel,
      update: await this.releases.updateFor(query.component, channel, query.version),
    };
  }
}
