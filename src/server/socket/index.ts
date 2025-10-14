import { Server as HttpServer } from "http";
import { Server as SocketIOServer, Socket } from "socket.io";
import { Logger } from "pino";
import {
  TransportControlRequest,
  SeekRequest,
  VolumeRequest,
  BrowseOptions,
  BrowseLoadOptions,
  BrowsePopOptions,
  BrowseSearchOptions,
  ErrorResponse,
} from "../../shared/types";
import { TransportService } from "../../core/roon/TransportService";
import { BrowseService } from "../../core/roon/BrowseService";

export interface SocketContext {
  io: SocketIOServer;
}

interface SocketDependencies {
  transportService: TransportService;
  browseService: BrowseService;
  logger: Logger;
}

export const attachSocketServer = (
  httpServer: HttpServer,
  deps: SocketDependencies
): SocketContext => {
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: process.env.CLIENT_ORIGIN ?? "*",
      methods: ["GET", "POST"],
    },
  });

  const { transportService, browseService, logger } = deps;

  const emitTransportError = (
    socket: Socket,
    command: string,
    message: string,
    ack?: (response: unknown) => void
  ) => {
    const payload: ErrorResponse = { error: message };
    if (ack) {
      ack({ error: message });
    } else {
      socket.emit("transport:error", { command, ...payload });
    }
  };

  const emitBrowseError = (
    socket: Socket,
    command: string,
    message: string,
    ack?: (response: unknown) => void
  ) => {
    const payload: ErrorResponse = { error: message };
    if (ack) {
      ack({ error: message });
    } else {
      socket.emit("browse:error", { command, ...payload });
    }
  };

  io.on("connection", (socket) => {
    logger.info({ clientId: socket.id }, "WebSocket client connected");

    const acknowledgeSuccess = (ack?: (response: unknown) => void): void => {
      if (ack) {
        ack({ success: true });
      }
    };

    socket.on(
      "transport:play-pause",
      async (
        payload: TransportControlRequest,
        ack?: (response: unknown) => void
      ) => {
        if (!payload?.zone_id) {
          emitTransportError(socket, "transport:play-pause", "zone_id required", ack);
          return;
        }

        try {
          await transportService.playPause(payload.zone_id);
          acknowledgeSuccess(ack);
        } catch (error) {
          logger.error({ err: error }, "Socket playPause command failed");
          emitTransportError(socket, "transport:play-pause", (error as Error).message, ack);
        }
      }
    );

    socket.on(
      "transport:next",
      async (
        payload: TransportControlRequest,
        ack?: (response: unknown) => void
      ) => {
        if (!payload?.zone_id) {
          emitTransportError(socket, "transport:next", "zone_id required", ack);
          return;
        }

        try {
          await transportService.next(payload.zone_id);
          acknowledgeSuccess(ack);
        } catch (error) {
          logger.error({ err: error }, "Socket next command failed");
          emitTransportError(socket, "transport:next", (error as Error).message, ack);
        }
      }
    );

    socket.on(
      "transport:previous",
      async (
        payload: TransportControlRequest,
        ack?: (response: unknown) => void
      ) => {
        if (!payload?.zone_id) {
          emitTransportError(socket, "transport:previous", "zone_id required", ack);
          return;
        }

        try {
          await transportService.previous(payload.zone_id);
          acknowledgeSuccess(ack);
        } catch (error) {
          logger.error({ err: error }, "Socket previous command failed");
          emitTransportError(socket, "transport:previous", (error as Error).message, ack);
        }
      }
    );

    socket.on(
      "transport:stop",
      async (
        payload: TransportControlRequest,
        ack?: (response: unknown) => void
      ) => {
        if (!payload?.zone_id) {
          emitTransportError(socket, "transport:stop", "zone_id required", ack);
          return;
        }

        try {
          await transportService.stop(payload.zone_id);
          acknowledgeSuccess(ack);
        } catch (error) {
          logger.error({ err: error }, "Socket stop command failed");
          emitTransportError(socket, "transport:stop", (error as Error).message, ack);
        }
      }
    );

    socket.on(
      "transport:seek",
      async (
        payload: SeekRequest,
        ack?: (response: unknown) => void
      ) => {
        if (!payload?.zone_id || typeof payload.seconds !== "number") {
          emitTransportError(
            socket,
            "transport:seek",
            "zone_id and numeric seconds required",
            ack
          );
          return;
        }

        try {
          await transportService.seek(payload.zone_id, payload.seconds);
          acknowledgeSuccess(ack);
        } catch (error) {
          logger.error({ err: error }, "Socket seek command failed");
          emitTransportError(socket, "transport:seek", (error as Error).message, ack);
        }
      }
    );

    socket.on(
      "transport:volume",
      async (
        payload: VolumeRequest,
        ack?: (response: unknown) => void
      ) => {
        if (!payload?.output_id || typeof payload.value !== "number") {
          emitTransportError(
            socket,
            "transport:volume",
            "output_id and numeric value required",
            ack
          );
          return;
        }

        try {
          await transportService.setVolume(payload.output_id, payload.value);
          acknowledgeSuccess(ack);
        } catch (error) {
          logger.error({ err: error }, "Socket volume command failed");
          emitTransportError(socket, "transport:volume", (error as Error).message, ack);
        }
      }
    );

    socket.on(
      "browse:browse",
      async (
        options: BrowseOptions,
        ack?: (response: unknown) => void
      ) => {
        if (!options?.hierarchy) {
          emitBrowseError(socket, "browse:browse", "hierarchy required", ack);
          return;
        }

        try {
          const result = await browseService.browse(options);
          if (ack) {
            ack(result);
          }
        } catch (error) {
          logger.error({ err: error }, "Socket browse command failed");
          emitBrowseError(socket, "browse:browse", (error as Error).message, ack);
        }
      }
    );

    socket.on(
      "browse:load",
      async (
        options: BrowseLoadOptions,
        ack?: (response: unknown) => void
      ) => {
        if (!options?.hierarchy || !options.itemKey) {
          emitBrowseError(socket, "browse:load", "hierarchy and itemKey required", ack);
          return;
        }

        try {
          const result = await browseService.load(options);
          if (ack) {
            ack(result);
          }
        } catch (error) {
          logger.error({ err: error }, "Socket browse load command failed");
          emitBrowseError(socket, "browse:load", (error as Error).message, ack);
        }
      }
    );

    socket.on(
      "browse:pop",
      async (
        options: BrowsePopOptions,
        ack?: (response: unknown) => void
      ) => {
        if (!options?.hierarchy) {
          emitBrowseError(socket, "browse:pop", "hierarchy required", ack);
          return;
        }

        try {
          const result = await browseService.pop(options);
          if (ack) {
            ack(result);
          }
        } catch (error) {
          logger.error({ err: error }, "Socket browse pop command failed");
          emitBrowseError(socket, "browse:pop", (error as Error).message, ack);
        }
      }
    );

    socket.on(
      "browse:search",
      async (
        options: BrowseSearchOptions,
        ack?: (response: unknown) => void
      ) => {
        if (!options?.input) {
          emitBrowseError(socket, "browse:search", "input required", ack);
          return;
        }

        try {
          const result = await browseService.search(options);
          if (ack) {
            ack(result);
          }
        } catch (error) {
          logger.error({ err: error }, "Socket browse search command failed");
          emitBrowseError(socket, "browse:search", (error as Error).message, ack);
        }
      }
    );

    socket.on("disconnect", (reason) => {
      logger.info({ clientId: socket.id, reason }, "WebSocket client disconnected");
    });
  });

  return { io };
};
