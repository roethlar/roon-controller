import { Server as HttpServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { getLogger } from "../../core/logger";

export interface SocketContext {
  io: SocketIOServer;
}

export const attachSocketServer = (httpServer: HttpServer): SocketContext => {
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: process.env.CLIENT_ORIGIN ?? "*",
      methods: ["GET", "POST"],
    },
  });

  const logger = getLogger();

  io.on("connection", (socket) => {
    logger.info({ clientId: socket.id }, "WebSocket client connected");

    socket.on("disconnect", (reason) => {
      logger.info({ clientId: socket.id, reason }, "WebSocket client disconnected");
    });
  });

  return { io };
};
