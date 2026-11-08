/**
 * 本轮不安装 @cloudbase/node-sdk（避免把云厂商 SDK 拉进本地安装包依赖树），
 * 只声明用到的最小入口形状。部署时 SDK 由云函数目录的 package.json 安装。
 */
declare module '@cloudbase/node-sdk' {
  interface CloudBaseApp {
    database(): any;
    uploadFile(options: { cloudPath: string; fileContent: Buffer }): Promise<{ fileID: string }>;
    downloadFile(options: { fileID: string }): Promise<{ fileContent: Buffer }>;
  }
  const cloudbase: {
    init(options: {
      env?: string;
      secretId?: string;
      secretKey?: string;
      region?: string;
    }): CloudBaseApp;
  };
  export default cloudbase;
}
