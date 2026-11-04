import { Injectable, StreamableFile } from '@nestjs/common';
import { createReadStream, readFileSync } from 'fs';
import { Observable, of } from 'rxjs';
import { Readable } from 'stream';
import { NonFile } from './non-file.js';

@Injectable()
export class AppService {
  // `randomBytes` has a max value of 2^31 -1. That's all this is
  private readonly MAX_BITES = Math.pow(2, 31) - 1;

  getReadStream(): StreamableFile {
    return new StreamableFile(
      createReadStream(new URL('../Readme.md', import.meta.url)),
    );
  }

  getBuffer(): StreamableFile {
    return new StreamableFile(readFileSync(new URL('../Readme.md', import.meta.url)));
  }

  getNonFile(): NonFile {
    return new NonFile('Hello world');
  }

  getRxJSFile(): Observable<StreamableFile> {
    return of(this.getReadStream());
  }

  getFileWithHeaders(): StreamableFile {
    const file = readFileSync(new URL('../Readme.md', import.meta.url));
    return new StreamableFile(
      createReadStream(new URL('../Readme.md', import.meta.url)),
      {
        type: 'text/markdown',
        disposition: 'attachment; filename="Readme.md"',
        length: file.byteLength,
      },
    );
  }

  getFileThatDoesNotExist(): StreamableFile {
    return new StreamableFile(createReadStream('does-not-exist.txt'));
  }

  getFileThatFailsMidway(): StreamableFile {
    let reads = 0;
    const stream = new Readable({
      read() {
        if (reads++ === 0) {
          this.push('first chunk');
        } else {
          this.destroy(new Error('EIO: i/o error, read'));
        }
      },
    });
    return new StreamableFile(stream);
  }

  getSlowStream(): StreamableFile {
    // Bounded source makes the upstream cancellation regression deterministic
    // without its original multi-gigabyte allocation.
    const stream = new Readable({ read() { this.push(Buffer.alloc(64 * 1024)); } });
    return new StreamableFile(stream);
  }
}
