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
      change_settings: jest.fn(),
      seek: jest.fn(),
      subscribe_zones: jest.fn(),
      subscribe_queue: jest.fn(),
      play_from_here: jest.fn(),
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

  describe('setPlaybackSettings', () => {
    it('should call transport.change_settings with provided settings', async () => {
      mockTransport.change_settings.mockImplementation(
        (_zoneId: string, _settings: Record<string, unknown>, callback: Function) => {
          callback(null);
        }
      );

      await service.setPlaybackSettings('zone123', { shuffle: true, loop: 'loop' });

      expect(mockTransport.change_settings).toHaveBeenCalledWith(
        'zone123',
        { shuffle: true, loop: 'loop' },
        expect.any(Function)
      );
    });
  });

  describe('subscribeQueue', () => {
    it('should normalize queue items and expose queue snapshot', () => {
      mockTransport.subscribe_queue.mockImplementation(
        (_zoneId: string, _maxItems: number, callback: Function) => {
          callback('Subscribed', {
            items: [
              {
                queue_item_id: 7,
                one_line: { line1: 'Track 1' },
              },
            ],
          });
          return { unsubscribe: jest.fn() };
        }
      );

      service.subscribeQueue('zone123', 100);
      const queue = service.getQueue('zone123');

      expect(mockTransport.subscribe_queue).toHaveBeenCalledWith(
        'zone123',
        5000,
        expect.any(Function)
      );
      expect(queue.zone_id).toBe('zone123');
      expect(queue.items).toHaveLength(1);
      expect(queue.items[0].queue_item_id).toBe(7);
    });

    it('should upsize queue subscription from zone metadata when available', () => {
      mockTransport.subscribe_zones.mockImplementation((callback: Function) => {
        callback('Subscribed', {
          zones: [
            {
              zone_id: 'zone123',
              display_name: 'Main Zone',
              state: 'playing',
              queue_items_remaining: 6200
            }
          ]
        });
      });

      mockTransport.subscribe_queue.mockImplementation(
        (_zoneId: string, _maxItems: number, callback: Function) => {
          callback('Subscribed', { items: [] });
          return { unsubscribe: jest.fn() };
        }
      );

      service.subscribeZones();
      service.subscribeQueue('zone123');

      expect(mockTransport.subscribe_queue).toHaveBeenCalledWith(
        'zone123',
        6233,
        expect.any(Function)
      );
    });

    it('should re-subscribe when a larger queue size is requested later', () => {
      const firstUnsubscribe = jest.fn();
      const secondUnsubscribe = jest.fn();
      mockTransport.subscribe_queue
        .mockImplementationOnce((_zoneId: string, _maxItems: number, callback: Function) => {
          callback('Subscribed', { items: [] });
          return { unsubscribe: firstUnsubscribe };
        })
        .mockImplementationOnce((_zoneId: string, _maxItems: number, callback: Function) => {
          callback('Subscribed', { items: [] });
          return { unsubscribe: secondUnsubscribe };
        });

      service.subscribeQueue('zone123', 5000);
      service.subscribeQueue('zone123', 9000);

      expect(firstUnsubscribe).toHaveBeenCalledTimes(1);
      expect(mockTransport.subscribe_queue).toHaveBeenNthCalledWith(
        1,
        'zone123',
        5000,
        expect.any(Function)
      );
      expect(mockTransport.subscribe_queue).toHaveBeenNthCalledWith(
        2,
        'zone123',
        9000,
        expect.any(Function)
      );
    });
  });

  describe('playFromHere', () => {
    it('should call transport.play_from_here', async () => {
      mockTransport.play_from_here.mockImplementation(
        (_zoneId: string, _queueItemId: number, callback: Function) => {
          callback({ name: 'Success' });
        }
      );

      await service.playFromHere('zone123', 4);

      expect(mockTransport.play_from_here).toHaveBeenCalledWith(
        'zone123',
        4,
        expect.any(Function)
      );
    });
  });
});
