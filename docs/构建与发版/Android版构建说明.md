> ⚠️ **v1 已退役文档 · 仅供历史参考**
> 本文描述的是 v1 时代（零后端单文件 / Tauri 桌面·安卓壳 / 飞书同步 / CI 三平台发版）的方案。
> v2 已于 2026-11-04 重构为「本地服务器 + 账号行级隔离 + NestJS/React/PGlite」并退役上述能力，项目更名为 **CareerAgent**。
> 当前架构与定位以 `docs/重设计构思-个人求职Agent工作台.md` 与 `docs/需求文档/00-产品定位与评审标尺.md` 为准。

# Android 版构建说明（Tauri 2.x Mobile）

本项目的 Android 版把现有「零构建」Web 前端（`index.html` + `css/` + `js/`）套进 Tauri 2.x 的
**移动端（Android）** 壳，一份代码产出 **APK**（真机安装 / 自测）与 **AAB**（上架 Google Play）。

- 前端仍**没有打包器**：`<script>` 顺序直加载，Tauri 侧开启 `withGlobalTauri`，
  JS 只用 `window.__TAURI__.core.invoke` 就能调 Rust 命令，**不需要任何 npm 前端依赖**。
- 与桌面壳**共用同一份前端产物**（`dist-desktop/`）与同一个 `frontendDist`
  （见 `src-tauri/tauri.conf.json` 的 `build.frontendDist = ../dist-desktop`）。
- **本机（macOS，无 JDK / Android SDK / NDK）无法构建 APK**，只能走 CI —— 详见第 2 节与第 4 节。

---

## 1. 目录与文件

| 路径 | 作用 |
|---|---|
| `src-tauri/` | Tauri 工程（Rust）：`Cargo.toml`、`build.rs`、`tauri.conf.json`、`src/*.rs`、`icons/` |
| `src-tauri/gen/android/` | **生成物**：`tauri android init` 现场生成的 Gradle / Kotlin / Manifest 工程，**不入库** |
| `js/store/native-bridge.js` | 前端桥：检测到 `window.__TAURI__` 才注入 `window.__RESUME_NATIVE__` |
| `tools/build-desktop-frontend.js` | 把前端资源白名单复制到 `dist-desktop/`（桌面与 Android 共用） |
| `.github/workflows/build-android.yml` | Android 出包 CI（JDK 17 + SDK + NDK + 4 个 rust target） |
| `.github/workflows/build-desktop.yml` | 桌面三平台出包 CI（互不影响） |

要点：

- **不要手写 `src-tauri/gen/` 下的任何文件**。它由 CLI 生成，手写模板无法跟随 CLI 版本升级，
  极易产出坏工程；本地与 CI 都执行 `tauri android init` 重新生成。
- 根 `.gitignore` 已忽略 `src-tauri/gen/`；`src-tauri/.gitignore` 另有 `/target` 与 `/gen/schemas`。
- `dist-desktop/` 同样不入库。

---

## 2. 前置依赖

| 依赖 | 版本 / 说明 | 本机状态 |
|---|---|---|
| **JDK 17** | 必须 17（Gradle 8 / AGP 要求）；`brew install temurin@17` 或用 Android Studio 自带 JBR | ❌ 未安装（`Unable to locate a Java Runtime`） |
| **Android SDK** | 设 `ANDROID_HOME`（macOS 默认 `~/Library/Android/sdk`），需含 platform / platform-tools / build-tools / cmdline-tools | ❌ 未安装，`ANDROID_HOME` 未设置 |
| **Android NDK** | 侧-by-side 安装，设 `NDK_HOME=$ANDROID_HOME/ndk/<版本>`；CI 用 `27.0.12077973` | ❌ 未安装 |
| **Rust 目标** | `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android` | 本机无 Rust 工具链 |
| **Node ≥ 16.7** | 仓库脚本用 `fs.cpSync`；CI 用 Node 22 | ✅ |
| `@tauri-apps/cli` | 唯一 devDependency，`npm install` 安装 | ✅（需先 `npm install`） |

环境变量（写入 `~/.zshrc`）：

```bash
export JAVA_HOME=$(/usr/libexec/java_home -v 17)      # macOS
export ANDROID_HOME=$HOME/Library/Android/sdk
export NDK_HOME=$ANDROID_HOME/ndk/27.0.12077973
```

> ### ⚠️ 本机若无 JDK / SDK / NDK，无法本地构建
> 三个依赖缺一不可：`tauri android init` 需要 Java + SDK，`tauri android build` 还需要 NDK 与 4 个 rust target。
> **缺任一都无法产出 APK/AAB** —— 此时**只能走 CI**（第 4 节），把代码推到 GitHub 触发
> `.github/workflows/build-android.yml`，从 Actions 下载产物。

---

## 3. 本地构建步骤（依赖齐全的机器上）

```bash
npm install                       # 装 @tauri-apps/cli

npm run mobile:android:init       # 生成 Android 工程 → src-tauri/gen/android
npm run mobile:android:dev        # 连真机/模拟器开发调试（需 adb 可见设备，或已启动 AVD）
npm run mobile:android:build      # 构建（等价 tauri android build）
```

三个脚本都**先跑 `npm run desktop:assets`**，把前端资源复制到 `dist-desktop/`（Android 与桌面共用）。

指定产物类型（脚本后追加的参数会透传给 `tauri android build`）：

```bash
npm run mobile:android:build -- --apk            # APK（release）
npm run mobile:android:build -- --aab            # AAB（release，上架用）
npm run mobile:android:build -- --apk --debug    # debug APK（自测用，无需签名）
npm run mobile:android:build -- --apk --target aarch64   # 只编 arm64
```

产物位置：

```
src-tauri/gen/android/app/build/outputs/
├── apk/universal/release/app-universal-release.apk    # 通用 APK（含全部 ABI）
├── apk/universal/debug/app-universal-debug.apk        # debug APK
├── apk/{arm64,arm,x86,x86_64}/release/...             # --split-per-abi 时按 ABI 分包
└── bundle/universalRelease/app-universal-release.aab  # AAB
```

`tauri android dev` 常用开关：`--host`（指定设备 IP）、`-d`（模拟器）。

---

## 4. CI 出包与 artifact 下载

`.github/workflows/build-android.yml` 在 `push`（main 分支且前端/Rust/配置/workflow 有变动）、
`pull_request` 与手动 `workflow_dispatch` 时运行，`runs-on: ubuntu-latest`。

流程：`checkout@v7` → `setup-java@v6`（JDK 17 / temurin）→ `android-actions/setup-android@v4` →
`sdkmanager` 安装 `ndk;27.0.12077973` 并导出 `NDK_HOME` → `setup-node@v7`（22）→
`dtolnay/rust-toolchain@stable` → `rustup target add` 4 个 Android 目标 → `swatinem/rust-cache@v2` →
`npm install` → **`npm run mobile:android:init`（现场生成 Android 工程）** →
`配置 Android 签名`（见第 5 节）→ **`tauri android build --apk --aab`（一步同时出两种包）** →
**`校验 APK 签名证书`**（见 5.7）→ `actions/upload-artifact@v7`（`if-no-files-found: error`）。

> **想看失败原因**：job 日志需要权限够的 token 才能通过 API 下载（否则 403），
> 详见第 8.1 节的三种通道。

> APK 与 AAB 用**同一条命令**产出：`--apk --aab` 在同一个进程内做两次打包、共享 Rust 产物。
> 拆成两条命令会让 4 个 ABI 的 Rust 编译被完整跑两遍（首轮构建多花十几分钟）。
>
> ⚠️ **`package.json` 里必须有 `"tauri": "tauri"` 这个 script**（见第 8 节最后一条）。
> 少了它，`tauri android init` 会把 `npm run -- tauri android android-studio-script`
> 烘焙进生成的 Gradle 工程，之后 Gradle 执行 `rustBuild*` 任务时必然
> `npm error Missing script: "tauri"` 而整条构建失败。
>
> action 主版本一律取**当前最新稳定**（checkout / setup-node 已到 v7，setup-java 到 v6）。
> v4 系列运行在 Node 20 上，GitHub 已弃用并会在日志里刷 deprecation 警告。

| artifact 名 | 内容 |
|---|---|
| `resume-studio-android-apk` | `src-tauri/gen/android/app/build/outputs/apk/**/*.apk` |
| `resume-studio-android-aab` | `src-tauri/gen/android/app/build/outputs/bundle/**/*.aab` |

**下载方式**：GitHub 仓库页 → **Actions** → 选中对应 workflow run → 页面底部 **Artifacts** 区下载 zip。
产物默认保留 14 天。

签名行为（见第 5 节）：4 个 secrets 齐全 → release 签名；缺任一 → **走 debug 签名并输出一条
`::notice::` 提示，workflow 不会失败**。

---

## 5. 签名配置（**密钥库绝不入库**）

> 本项目已生成好一套可用凭据，放在 `android-signing/`（该目录被双保险忽略，见 5.6）。
> 你只需把其中 4 个值填进 GitHub Secrets（见 5.3）。

### 5.1 生成上传密钥（需要 JDK 的 `keytool`）

```bash
JDK="$HOME/.workbuddy/binaries/java/temurin-17"   # 本机已装，见文末
"$JDK/bin/keytool" -genkeypair \
  -keystore android-signing/resume-studio-upload.keystore \
  -storetype PKCS12 \
  -alias resume-studio \
  -keyalg RSA -keysize 4096 -sigalg SHA256withRSA \
  -validity 10000 \
  -dname "CN=Resume Studio, OU=Release, O=Resume Studio, L=Shenzhen, ST=Guangdong, C=CN" \
  -storepass "$PW" -keypass "$PW"
```

这些参数别乱改，各自的理由：

| 参数 | 为什么这样取值 |
|---|---|
| `-storetype PKCS12` | JDK 9 起 `keytool` 的默认格式，也是 AGP 未指定 `storeType` 时的默认。**PKCS12 下 `keypass` 必须等于 `storepass`**（JKS 才允许两者不同） |
| `-alias resume-studio` | 与 CI 写入的 `keystore.properties` 里 `keyAlias` 一致；改名要同步改 secret |
| `-keysize 4096` + `SHA256withRSA` | Play 接受，比 2048 更耐时间 |
| `-validity 10000` | ≈27 年。Play 要求上传密钥有效期至少覆盖到 **2033-10-22**，而 `keytool` 默认只有 90 天 |
| `-dname` | **不要写真名 / 真公司**——这段会随 APK 公开可见（本项目用中性占位） |

### 5.2 编码为 base64（必须单行）

```bash
openssl base64 -A -in android-signing/resume-studio-upload.keystore \
  -out android-signing/resume-studio-upload.keystore.base64
```

> 用 `openssl base64 -A`（`-A` = 不折行）。macOS 自带的 `base64 -i file` 会按 76 列折行；
> CI 侧虽然用 `base64 -d` 能容忍换行，但统一单行最不容易踩坑。

**用之前先自检一遍**（解码回文件 → 字节比对 → 让 `keytool` 真打开一次）：

```bash
base64 -d < android-signing/resume-studio-upload.keystore.base64 > /tmp/rt.keystore
cmp android-signing/resume-studio-upload.keystore /tmp/rt.keystore && echo "字节一致"
"$JDK/bin/keytool" -list -keystore /tmp/rt.keystore -storepass "$PW"
```

### 5.3 配置 4 个 GitHub Secrets

仓库页 → **Settings → Secrets and variables → Actions → Secrets → New repository secret**：

| secret | 取值 |
|---|---|
| `ANDROID_KEY_BASE64` | `android-signing/resume-studio-upload.keystore.base64` 的**全部内容**（单行，约 5.8 KB） |
| `ANDROID_KEY_ALIAS` | `resume-studio` |
| `ANDROID_KEY_PASSWORD` | keystore 口令（PKCS12 下与下面同一个值） |
| `ANDROID_STORE_PASSWORD` | keystore 口令（同上） |

> 4 个都填了才走 release 签名；**缺任一个会自动回退 debug 签名**并输出一条 `::notice::`，
> workflow 不会失败——能装真机验证，但不能上架。

### 5.4 CI 里实际做了什么

`.github/workflows/build-android.yml` 的「配置 Android 签名」步骤：

1. 先判断 4 个 secret 是否齐全，不齐则 `signed=false` 并跳过整步；
2. `base64 -d` 解码到 `$RUNNER_TEMP/upload-keystore.jks`——**临时目录，构建结束随 runner 销毁**；
3. 在生成的工程里写 `src-tauri/gen/android/keystore.properties`：

   ```properties
   storeFile=$RUNNER_TEMP/upload-keystore.jks
   storeType=PKCS12
   storePassword=***
   keyAlias=resume-studio
   keyPassword=***
   password=***
   ```

4. 官方模板的 `app/build.gradle.kts` **不含 release 签名配置**，CI 按
   [Tauri 官方文档](https://v2.tauri.app/distribute/sign/android/)补**三段**：

   | # | 插入位置 | 内容 |
   |---|---|---|
   | ① | 文件开头（最后一条 `import` 之后） | `import java.io.FileInputStream` |
   | ② | `android {}` 内、`buildTypes` **之前** | `signingConfigs { create("release") { … } }` |
   | ③ | 模板已有的 release buildType 内 | `signingConfig = signingConfigs.getByName("release")` |

   补丁是幂等的（已含 `keystore.properties` 或 `signingConfigs` 就整段跳过）——
   因为 `gen/android` 每次 CI 都重新生成。

   ⚠️ **三条 Gradle / Kotlin DSL 规则**（本项目**实测踩过两轮**，见第 8 节）：

   1. **不能用 `java.util.Properties` 这类全限定名**。Gradle Kotlin DSL 的脚本隐式接收者是
      `Project`，而 `Project` 上挂着一个 **`java` 扩展（`JavaPluginExtension`）**，它会把
      `java` 这个标识符**遮蔽**成扩展属性，于是 `java.util.Properties` 被解析为「`java` 扩展的
      `util` 成员」→ 报 `Unresolved reference: util` / `Unresolved reference: io`。
      解法是文件顶层 import + **简单名**（`Properties()`）——而不是「去补 import」。
   2. **import 必须先查再插，绝不能无条件插一整块**。模板**第一行本来就是**
      `import java.util.Properties`（模板自己的 `val tauriProperties = Properties().apply { … }`
      就在用它）。无条件再插一遍 → 两行同名 import → Kotlin 报
      `Conflicting import, imported name 'Properties' is ambiguous`，整条构建失败。
      2026-09-19 就是这么炸的：第 12 步「配置 Android 签名」**绿**、第 13 步「构建 APK + AAB」
      跑满 **213 秒后红**。注意报错出现在 **Gradle 配置阶段的 Kotlin 脚本编译**里，
      跟签名逻辑本身无关，所以「日志里看不出签名相关字样」是正常的。
   3. **`import` 要插在 `@file:` 注解之后、任何声明之前**，且写入前要保证文件以换行结尾，
      否则拼接处会出现 `}val …` 这种语法错误（模板渲染结果**末尾没有换行**，这条是真会触发的）。

   补丁脚本自带**五条计数自检**（两个 `import` 各恰好 1 次、`signingConfigs {` 1 次、
   `buildTypes {` 1 次、`signingConfig = …` 1 次）与**锚点断言**（找不到 `buildTypes {`
   或 `getByName("release") {` 就立刻 `::error::` 退出）。设计意图很明确：
   **宁可 0 秒失败，也不要让 Gradle 白跑 3 分钟再抛一句 `Script compilation errors`。**
   补丁后会把**全文打进日志** —— 定位上面那个重复 import，靠的正是这段日志。

5. 构建完成后跑**「校验 APK 签名证书」**步骤：读产物证书的 SHA-256，与硬编码的
   `EXPECTED_SHA256` 比对，不符则直接失败。目的是把「签名配置是否真的生效」从**静默行为**
   变成硬断言（原因见 5.7）。

### 5.5 本地签名（想在本机出 release 包时）

把 `keystore.properties` 放到 `src-tauri/gen/android/`（生成目录，不入库），
并把 5.4 的 Gradle 补丁手动加到 `app/build.gradle.kts`：

```properties
storeFile=/绝对路径/android-signing/resume-studio-upload.keystore
storeType=PKCS12
storePassword=***
keyAlias=resume-studio
keyPassword=***
```

### 5.6 凭据隔离与运维

- **忽略规则**：仓库根 `.gitignore` 覆盖整个 `android-signing/`、`*.jks`、`*.keystore`、
  `keystore.properties`；`android-signing/` 内**另有一层 `.gitignore`（内容为 `*`）**做双保险，
  防误用 `git add -f`。提交前用 `git status --short` 确认该目录不出现。
- **务必离线备份**：keystore 一旦用于 Play 上架，**丢失就再也无法更新同一个应用**
  （只能换包名重新上架）。请连同口令一起存进密码管理器。
  本项目把口令放在 `android-signing/ANDROID-SIGNING-CREDENTIALS.txt`（同样不入库，仅供自取）。
- **核对指纹**：`keytool -list -v` 会打印 SHA-256。Android 与 Play 后台都按指纹校验，
  轮换密钥时用它确认换对了。
- **轮换**：重新生成 → 重算 base64 → 更新 4 个 secret 即可，代码与 workflow 都不用动。
  ⚠️ 轮换后要**同步更新 `build-android.yml` 里的 `EXPECTED_SHA256`**，否则签名断言会误报失败。

### 5.7 为什么 CI 要自己断言签名（不能只看「配置成功」）

**签名配置失败是静默的**：Gradle 不会因为 secrets 为空或补丁没生效而报错，它只会悄悄退回
debug 签名，日志里仅有一条不起眼的 `::notice::`。等到上架被 Play 拒绝时才发现，代价已经很大。

因此 `build-android.yml` 在构建之后、上传之前加了一步**「校验 APK 签名证书」**：

1. 找到 release APK（找不到就退而取任一 `.apk`，找不到则直接失败）；
2. 用 `apksigner verify --print-certs` 读证书（它能验 v2/v3 签名方案）；`apksigner` 不在时
   退回 `keytool -printcert -jarfile`（只认 v1）；
3. 两种工具的指纹格式不同（`apksigner` 无冒号小写 / `keytool` 带冒号大写），统一归一化后再比；
4. `signed=true` 且指纹不符 → **`exit 1`，构建失败**；`signed=false`（fork 或未配 secrets）→
   只发 `warning`，不阻断。

> 这条断言的价值在于**把「我以为配好了」变成「CI 说配好了」**。没有它，你只能靠人工下载 APK、
> 手动 `apksigner verify` 去核对。

<details>
<summary>本机 JDK 是怎么装上的（如需重装）</summary>

本机原本没有 JDK（`/usr/bin/keytool` 是 macOS 的空壳，直接调用会报
"Unable to locate a Java Runtime"），而生成密钥库必须用 `keytool`。安装方式：

```bash
# GitHub Release 直连在本机被代理拦截（502），改用清华镜像
curl -L -o jdk17.tar.gz \
  https://mirrors.tuna.tsinghua.edu.cn/Adoptium/17/jdk/aarch64/mac/OpenJDK17U-jdk_aarch64_mac_hotspot_17.0.20.1_1.tar.gz
tar -xzf jdk17.tar.gz
# macOS 的 tar 包是 bundle 结构（jdk-*/Contents/Home/...），要把 Contents/Home 上提一层
mv jdk-17*+1/Contents/Home "$HOME/.workbuddy/binaries/java/temurin-17"
# 压缩包 177 MB，解压后约 309 MB；只用来生成密钥库的话，装完即可整个删除
```

</details>

---

### 5.8 本机没有 JDK / Android SDK 时怎么验证这段补丁

本机（macOS）既没有 JDK 也没有 Android SDK，跑不了 `gradlew` —— 但这不代表只能靠 CI 试错
（2026-09-19 连炸两次，就是因为没在推送前做下面这件事）。

**关键一：真模板可以直接从 CLI 二进制里抽出来。** Tauri 把 Android 工程模板内嵌在
`@tauri-apps/cli-<平台>` 的 `.node` 二进制里，是明文：

```bash
python3 - <<'PY'
data = open('node_modules/@tauri-apps/cli-darwin-arm64/cli.darwin-arm64.node','rb').read()
i = data.find(b'import java.util.Properties')
s = data.rfind(b'app/build.gradle.kts', 0, i) + len(b'app/build.gradle.kts')
e = data.find(b'app/proguard-rules.pro', i)
open('/tmp/tpl.kts','wb').write(data[s:e])   # 再把 {{...}} 占位符替换成实际值，即得真模板
PY
```

**关键二：把该步骤的 `run` 脚本原样抽出来、在临时目录里用真模板实跑。**

```python
doc = yaml.safe_load(open('.github/workflows/build-android.yml', encoding='utf-8'))
run = [s for s in doc['jobs']['build-android']['steps'] if s.get('id') == 'signing'][0]['run']
# 在临时目录造 app/build.gradle.kts（真模板），设好 RUNNER_TEMP / GITHUB_OUTPUT / 4 个
# ANDROID_* 环境变量，然后 /bin/bash -e -o pipefail -c run
```

- **为什么是「原样抽出实跑」而不是「照着逻辑另写一份测试」**：后者只验证我的理解，
  前者才验证得了环境差异（缩进、模板末尾无换行、`@file:` 注解、模板升级导致锚点失效）。
- 覆盖用例：真模板 / 幂等二次运行 / 模板缺 `import java.util.Properties` / 带 `@file:` 注解 /
  缺 `buildTypes {` 锚点 / 缺 `getByName("release")` 锚点 / 模板自带 `signingConfigs` /
  已含 `keystore.properties`。
- 2026-09-19 这套方法 **40/40 通过**，并在推送前抓出了「重复 import」这个真缺陷。

**关键三：keystore 本身也能在无 JDK 时用 `openssl` 核对**（下面三项此前**从未被跑过**，
属于典型的「配了但没验证」）：

```bash
# 1) 格式：决定 storeType 该写什么
xxd -l 8 android-signing/resume-studio-upload.keystore   # 30 82 … 02 01 03 = PKCS12；FE ED FE ED = JKS
# 2) 私钥 bag 的 friendlyName：JDK 拿它当 alias，缺了会自造 "1"，与 ANDROID_KEY_ALIAS 对不上
openssl pkcs12 -in "<keystore>" -nocerts -nodes -passin pass:"$PW" </dev/null | head -8
# 3) 证书指纹：必须等于 build-android.yml 里的 EXPECTED_SHA256
openssl pkcs12 -in "<keystore>" -nokeys -passin pass:"$PW" | openssl x509 -noout -fingerprint -sha256
```

> ⚠️ 两个环境坑：macOS 自带的是 LibreSSL，**没有 `timeout` 命令**（会 `command not found`，
> 表现为「输出为空」而不是报错，极易误判）；`openssl pkcs12 -info` 会**交互式索要 PEM 口令**
> 把命令挂住 → 必须配 `-nodes` 且把 stdin 接到 `/dev/null`。

本项目 2026-09-19 的核对结果：keystore = **PKCS12**（所以 `storeType=PKCS12` 是对的，
尽管文件名是 `.jks`）；私钥 bag `friendlyName: resume-studio`（与 `ANDROID_KEY_ALIAS` 一致）；
证书 `CN=Resume Studio`，有效期 2026-09-18 → 2054-02-03；
SHA-256 = `8db64d11…5230`，**与 CI 里写死的 `EXPECTED_SHA256` 完全一致**。

## 6. 真机安装与调试

```bash
adb devices                                      # 确认设备已连接（并已授权 USB 调试）
adb install -r app-universal-debug.apk           # 安装 / 覆盖安装（debug 包最省事）
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
adb logcat | grep -i tauri                       # 看运行时日志
adb uninstall com.resumestudio.desktop            # 卸载（包名 = tauri.conf.json 的 identifier）
```

> Android 11+ 若提示签名不一致，先卸载旧包再装；release 包必须用同一 keystore 签名才能覆盖升级。

---

## 7. 移动端 UI 行为（本期加固）

| 主题 | 实现 | 降级 |
|---|---|---|
| 视口 | `index.html` 的 viewport 带 `viewport-fit=cover`，否则 `env(safe-area-inset-*)` 恒为 0 | — |
| 软键盘 | `js/app.js` 监听 `window.visualViewport` 的 `resize`/`scroll`，把可视高度/键盘高度写入 CSS 变量 `--vvh` / `--kb`；`.app{height:var(--vvh)}`、`.mobile-tabbar{bottom:var(--kb)}` | 无 `visualViewport` 时退化为 `window.innerHeight`（`--kb=0`）；再不行 CSS 有 `100vh` / `0px` 兜底 |
| 聚焦防遮挡 | 小屏/触控设备下，`focusin` 后延迟 300ms 把输入框 `scrollIntoView({block:'center'})` | 非小屏不触发 |
| 返回键 | History API：进入编辑/同步视图时 `pushState({mv:view})`；`popstate` 时先关可见弹层，再回预览视图，已在预览页且无弹层才真正后退 | 原生壳做能力探测监听 Tauri 事件，拿不到则静默跳过；Android WebView 的系统返回键本身触发 `history.back()`，浏览器路径已覆盖 |
| 手感 | `overscroll-behavior`、`-webkit-tap-highlight-color:transparent`、长按选中抑制（正文与 `#editor` 仍可选中）、输入框字号 ≥16px | 全部只在 `≤640px` / `(pointer:coarse)` 内生效，桌面零变化 |

---

## 8. 常见报错排查

| 现象 | 原因与处理 |
|---|---|
| `Unable to locate a Java Runtime` / `JAVA_HOME is not set` | 未装 JDK 17。装 Temurin 17 并导出 `JAVA_HOME`（装法见第 5 节文末）；CI 由 `setup-java@v6` 处理 |
| `ANDROID_HOME not set` / `SDK location not found` | 未设 `ANDROID_HOME`（CI 由 `android-actions/setup-android@v4` 设置；本地写入 shell 配置） |
| `设置 Android SDK` 步骤 **20 秒即失败**、日志里出现 `Failed to find package 'tools'` | `android-actions/setup-android` 用了 **v3**。v3.2.2 的默认 `packages` 含 `tools`，而 **Google 已把 `tools` 包从 `repository2-3.xml` 移除** → `sdkmanager tools` 报错并把整个 action 拖垮。**升到 `@v4`**（v4.0.2 起只装 `platform-tools`）。这是本项目实测踩到的坑，见 `docs/验收与记录/跨平台改造-验收标准与验收记录.md` |
| `Execution failed for task ':app:rustBuildArm64Debug'`，且构建日志里有 `npm error Missing script: "tauri"` | **`package.json` 缺 `"tauri": "tauri"` script**。`tauri android init` 会按「当前是怎么启动 CLI 的」来推断，在 npm 脚本里启动时推断结果是 `npm run -- tauri android android-studio-script`，并把这条命令**烘焙进 `buildSrc/src/main/kotlin/BuildTask.kt`**（`val executable = "npm"; val args = listOf("run","--","tauri",...)`）。之后 Gradle 的 `rustBuild*` 任务执行它 → npm 找不到 `tauri` script → 失败。**修法：在 `package.json` 的 scripts 里加 `"tauri": "tauri"`**（`create-tauri-app` 官方模板本来就带这一条，本项目是手工包壳所以漏了）。自检：`npm run -- tauri --version` 应打印 `tauri-cli x.y.z` |
| `NDK not configured` / `NDK_HOME` 未生效 / `No toolchains found` | 用 `sdkmanager --install "ndk;27.0.12077973"` 安装并导出 `NDK_HOME=$ANDROID_HOME/ndk/27.0.12077973`（同时设 `ANDROID_NDK_HOME` 兼容旧脚本） |
| `error: target ... may not be enabled` / 链接器报 `arm-linux-androideabi` 缺失 | rust target 未装全：`rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android` |
| Gradle 下载超时 / `Could not resolve com.android.tools.build:gradle` | 网络问题或代理未配；重跑一次；自建环境可配 `~/.gradle/gradle.properties` 的代理；CI 上通常是偶发，重试 workflow |
| `Could not resolve all files` / 依赖下载卡在 `services.gradle.org` | 同上；也可在公司网络下改用内网 Gradle 镜像 |
| 安装时 `INSTALL_FAILED_UPDATE_INCOMPATIBLE` / 签名不匹配 | 旧包是另一 keystore 签的。先 `adb uninstall com.resumestudio.desktop` 再装 |
| release 包未签名（`app-universal-release-unsigned.apk`） | `keystore.properties` 缺失或 `build.gradle.kts` 没有 release signingConfig。检查第 5 节；CI 未配 secrets 时会有 `::notice::` 提示并自动改走 debug 签名 |
| **`e: app/build.gradle.kts:NN:CC: Unresolved reference: util`（或 `: io`）** | Gradle Kotlin DSL 的 `Project` 上挂着 **`java` 扩展（`JavaPluginExtension`）**，它把 `java` 这个标识符遮蔽了，于是 `java.util.Properties` / `java.io.FileInputStream` 这种**全限定名会被当成「`java` 扩展的成员访问」**而解析失败。**修法：别写全限定名，改用文件顶层 import + 简单名**（`Properties()` / `FileInputStream(f)`）。⚠️ 这是「写多了」而不是「写少了」—— 2026-09-19 曾把它误判成「缺 import」，去补 import 反而引出下面那条重复 import 的缺陷。⚠️ 它也**只会在「secrets 配齐、补丁真的执行」时才暴露** —— 未配 secrets 时步骤会提前 `exit 0`，补丁根本不跑，缺陷会一直潜伏 |
| **`e: app/build.gradle.kts:2:18: Conflicting import, imported name 'Properties' is ambiguous`**（连着两条，行号相邻） | **同一个 import 被插了两遍**。Tauri 模板 `app/build.gradle.kts` 的**第一行本来就是** `import java.util.Properties`（模板自身的 `val tauriProperties = Properties().apply { … }` 就在用它），补丁若无条件再插一遍就会重复。**修法：import 一律「先查再插」**（`re.search(r'^\s*import\s+java\.util\.Properties\s*$', s, re.M)` 命中就跳过）。典型现象：第 12 步「配置 Android 签名」**绿**、第 13 步「构建 APK + AAB」跑满 **3 分钟才红**、且报错与签名毫无关系 —— 因为它在 **Gradle 配置阶段的 Kotlin 脚本编译**里。定位靠「补丁后把全文打进日志」（见 5.4） |
| 签名步骤日志显示「配置成功」，但构建在 `:app:compileDebugKotlin` 或 Kotlin 编译阶段失败 | 同上一条。判断依据：日志里出现 `w: file:///.../app/build.gradle.kts` 或 `e: app/build.gradle.kts:<行号>`。**注意 Gradle 配置阶段的 Kotlin 脚本编译错误不会被「配置成功」的 notice 拦住** —— 那个 notice 只说明文件写进去了，不代表它能编译 |
| 想知道 CI 到底错在哪，但 `job 日志` 打不开 / 只有弃用警告 | 见第 8.1 节：先确认用**有 `Actions: read` 的 token** 下载 job 日志；读不到时再看 `::error::` annotation（workflow 在构建失败分支主动把关键行打成 annotation） |
| `Keystore was tampered with, or password was incorrect` | 口令不对。**注意 PKCS12 下 `keyPassword` 必须与 `storePassword` 相同**（JKS 才允许不同）；也可能是 secret 里复制进了多余空格/换行 |
| `Invalid keystore format` / `toDerInputStream rejects tag type` / `Unsupported keystore format` | `storeType` 与文件实际格式不匹配（JKS ↔ PKCS12 混淆）。本项目统一用 PKCS12，并已在 CI 显式写入 `storeType=PKCS12`；若你换成 JKS，务必同步改 `keystore.properties` 与 Gradle 里的 `storeType` |
| `Key with alias '...' was not found` / `Cannot recover key` | `ANDROID_KEY_ALIAS` 写错。用 `keytool -list -keystore <file> -storepass <pw>` 打出真实别名核对 |
| `storeFile ... does not exist` / `base64: invalid input` | `ANDROID_KEY_BASE64` 为空或不是完整单行。用第 5.2 的「自检」命令先本地验一遍再贴 |
| 构建日志显示 `未配置 ... 走 debug 签名` 而你以为配了 | 4 个 secret **缺任一个**都会整体回退 debug。检查名称拼写（含大小写）与是否建在 **Secrets** 而非 **Variables** |
| `tauri android init` 报 identifier 不合法 / 改过 identifier | `tauri.conf.json` 的 `identifier` 改动后要 **重新 init**（删掉 `src-tauri/gen/android` 再生成），否则包名与配置不一致 |
| 打出来的包白屏 / 资源 404 | `dist-desktop/` 是旧的或缺失。`mobile:android:*` 脚本会先跑 `npm run desktop:assets`；手动跑 `tauri` 命令前请补跑一次 |
| `frontendDist ../dist-desktop not found` | 同上，先 `npm run desktop:assets` |

### 8.1 怎么读到 CI 的失败日志

这是本项目反复花时间的地方，值得单独记一笔。三条通道，优先级从高到低：

**① 直接下载 job 日志（首选）**

```bash
TOKEN=<一个有 Actions:read 与 Contents:read 的 PAT>
curl -sL -o joblog.txt \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/<owner>/<repo>/actions/jobs/<job_id>/logs"
```

> ⚠️ **需要一个权限够的 token**。用权限不足的凭据时，这个接口（**即便在 public 仓库上**）会返回
> `403 Must have admin rights`。本项目一开始就是被这个 403 挡住的，于是绕道去读 annotation
> —— 而 annotation 只够看个大概。**换成有写权限的 PAT 后，同一个接口立刻返回 200 与完整日志。**
> 所以「读不到日志」时，第一件事是怀疑 token 权限，而不是放弃。

**② 看 `::error::` annotation（读不到日志时的兜底）**

workflow 的构建失败分支会主动把「环境事实 / 关键词命中行 / 日志尾部」打成三条 `::error::`
annotation，可通过 API 读到：

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.github.com/repos/<owner>/<repo>/commits/<sha>/check-runs" \
  | python3 -c "import sys,json; [print(c['id'], c['name']) for c in json.load(sys.stdin)['check_runs']]"
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.github.com/repos/<owner>/<repo>/check-runs/<check_run_id>/annotations"
```

注意：**`/actions/runs/{id}/jobs/{job_id}/annotations` 这个路径不存在（404）**，
annotation 要从 `check-runs` 端点取。

写 annotation 时 `%` → `%25`、去掉 `\r`、`::` → ` : : `，否则 workflow command 会被截断；
并且 `run` 默认是 `bash -e`，`[ -n "$X" ] && echo ...` 在 `$X` 为空时会**中止步骤**把后面的
annotation 吃掉，要用 `if`。

**③ 人肉打开 Actions 网页** —— 最慢但永远可用。

---

## 9. 与桌面壳的关系（零回归）

- **同一份前端产物**：Android 与桌面都吃 `dist-desktop/`，`tauri.conf.json` 里只有一个
  `frontendDist`，平台差异只用 `tauri.<platform>.conf.json` 覆盖（目前未用到）。
- 桌面脚本 `desktop:dev` / `desktop:build` 与移动端 `mobile:android:*` **互不干扰**，
  两个 CI workflow 也各自独立触发。
- 移动端加固的 CSS 全部写在 `@media (max-width:640px)` / `@media (pointer:coarse)` 内，
  `@media print` 与桌面样式未改动；`js/app.js` 只新增函数（返回键、软键盘），
  渲染 / `recordHistory` / `undo` / `redo` 未改动。
- `js/store/native-bridge.js` 在浏览器中仍不注入任何全局，`ResumeStore` 的浏览器降级路径不变；
  `npm start` 的本地服务工作流不受影响。
- **iOS 不在本轮**：需要完整 Xcode（本机只有 Command Line Tools）。
