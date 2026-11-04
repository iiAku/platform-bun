// The controller of Nest's benchmark, decorated by hand so that the same file
// runs under Node and Bun without a TypeScript build
import "reflect-metadata";
import { Controller, Get, Module } from "@nestjs/common";

export class AppController {
  root() {
    return "Hello world!";
  }
}
Get()(
  AppController.prototype,
  "root",
  Object.getOwnPropertyDescriptor(AppController.prototype, "root"),
);
Reflect.defineMetadata(
  "design:paramtypes",
  [],
  AppController.prototype,
  "root",
);
Controller("/")(AppController);

export class AppModule {}
Module({ controllers: [AppController] })(AppModule);

export const port = Number(process.env.PORT ?? 3000);
export const options = { logger: false, bodyParser: false };
