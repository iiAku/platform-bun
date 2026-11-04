import express from "express";

const app = express();
app.get("/", (_request, response) => {
  response.send("Hello world!");
});
app.listen(Number(process.env.PORT ?? 3000));
