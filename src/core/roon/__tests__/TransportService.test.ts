import { TransportService } from '../TransportService';
import { RoonClient } from '../RoonClient';
import { Logger } from 'pino';
import { CoreUnpairedError, RoonOperationError } from '../errors';

// Mock RoonClient
const mockRoonClient = {
  getTransport: jest.fn(),
  getBrowse: jest.fn(),
  getImage: jest.fn(),
  getCoreInfo: jest.fn(),
  getCoreStatus: jest.fn(),
  on: jest.fn(),
  start: jest.fn(),
} as unknown as RoonClient;

// Mock Logger
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  level: 'info',
} as unknown as Logger;

describe('TransportService', () => {
  let service: TransportService;
  let mockTransport: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockTransport = {
      control: jest.fn(),
      change_volume: jest.fn(),
      seek: jest.fn(),
      subscribe_zones: jest.fn(),
    };
    (mockRoonClient.getTransport as jest.Mock).mockReturnValue(mockTransport);
    service = new TransportService(mockRoonClient, mockLogger);
  });

  describe('playPause', () => {
    it('should call transport.control with playpause action', async () => {
      mockTransport.control.mockImplementation((_zoneId: string, _action: string, callback: Function) => {
        callback(null);
      });

      await service.playPause('zone123');

      expect(mockTransport.control).toHaveBeenCalledWith(
        'zone123',
        'playpause',
        expect.any(Function)
      );
    });

    it('should throw CoreUnpairedError when transport unavailable', async () => {
      (mockRoonClient.getTransport as jest.Mock).mockReturnValue(null);

      await expect(service.playPause('zone123')).rejects.toThrow(CoreUnpairedError);
    });

    it('should reject with RoonOperationError on failure', async () => {
      mockTransport.control.mockImplementation((_zoneId: string, _action: string, callback: Function) => {
        callback('Roon error');
      });

      await expect(service.playPause('zone123')).rejects.toThrow(RoonOperationError);
    });
  });

  describe('next', () => {
    it('should call transport.control with next action', async () => {
      mockTransport.control.mockImplementation((_zoneId: string, _action: string, callback: Function) => {
        callback(null);
      });

      await service.next('zone123');

      expect(mockTransport.control).toHaveBeenCalledWith('zone123', 'next', expect.any(Function));
    });
  });

  describe('setVolume', () => {
    it('should call transport.change_volume with correct parameters', async () => {
      mockTransport.change_volume.mockImplementation((_outputId: string, _how: string, _value: number, callback: Function) => {
        callback(null);
      });

      await service.setVolume('output123', 50);

      expect(mockTransport.change_volume).toHaveBeenCalledWith(
        'output123',
        'absolute',
        50,
        expect.any(Function)
      );
    });
  });

  describe('getZones', () => {
    it('should return empty array when no zones subscribed', () => {
      const zones = service.getZones();
      expect(zones).toEqual([]);
    });
  });

  describe('getZone', () => {
    it('should return undefined for non-existent zone', () => {
      const zone = service.getZone('nonexistent');
      expect(zone).toBeUndefined();
    });
  });
});
