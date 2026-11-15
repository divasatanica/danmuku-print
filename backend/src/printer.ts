export interface PrintJob {
  viewerNumber: number;
  nickname: string;
  content: string;
  roomId: string;
  eventId: string;
  timestamp: number;
}

export interface Printer {
  print(job: PrintJob): Promise<void>;
}

export class MockPrinter implements Printer {
  async print(job: PrintJob): Promise<void> {
    const record = JSON.stringify({ type: 'mock-print', ...job }) + '\n';
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(record, (error) => error ? reject(error) : resolve());
    });
  }
}
