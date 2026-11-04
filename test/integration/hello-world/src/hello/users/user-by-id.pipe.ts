import { PipeTransform, Injectable, ArgumentMetadata } from '@nestjs/common';
import { UsersService } from './users.service.js';

@Injectable()
export class UserByIdPipe implements PipeTransform<string> {
  constructor(private readonly usersService: UsersService) {}

  transform(value: string, _metadata: ArgumentMetadata) {
    return this.usersService.findById(value);
  }
}
