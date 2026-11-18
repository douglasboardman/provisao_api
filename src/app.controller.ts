import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { readFileSync } from 'fs';
import { join } from 'path';

const pkgVersion: string = JSON.parse(
  readFileSync(join(process.cwd(), 'package.json'), 'utf-8'),
).version;

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('version')
  getVersion() {
    return { version: pkgVersion };
  }
}
