export interface WriteFileOutPort {
    writeFile(destinationDirectory: string, fileName: string, content: string): Promise<string>;
}
