/**
 * 真机就绪自检（`npm run hw:check`）：不开浏览器、不连设备，只回答「现在能不能跑真机验收」。
 *
 * 为什么需要它：`npm run hw:soak` 要在系统对话框里人工选设备，如果模块没上电，
 * 会在连接窗口里干等几分钟才失败。先跑这个，10 秒内能看出缺什么：
 *   · 串口：有没有 USB 串口桥（CP210x / CH340 / FTDI / CDC）；
 *   · BLE：模块是否在系统里（配对记录 + 最近连接时间）、蓝牙无线电是否打开；
 *   · 给出下一步该跑哪条命令。
 *
 * 退出码：0 = 至少有一条通道看起来可用；1 = 两条都不行（需要先上电/接硬件）。
 */
import { execFileSync } from "node:child_process";

const isWin = process.platform === "win32";
const run = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return ""; }
};

function windowsProbe() {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    // 1) USB 串口桥
    "$bridges = Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match 'CP210|CH34|FTDI|USB-SERIAL|USB Serial|CDC' } | Select-Object -ExpandProperty Name",
    "Write-Output ('BRIDGES=' + (($bridges -join '|')))",
    // 2) BLE 设备节点（只看配对记录里的名字与最近连接时间）
    "$ble = Get-PnpDevice -Class Bluetooth | Where-Object { $_.InstanceId -like 'BTHLE*' -and $_.FriendlyName -notmatch '服务|Service|配置文件|Profile' }",
    "foreach ($d in $ble) {",
    "  $last = (Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName 'DEVPKEY_Bluetooth_LastConnectedTime').Data",
    "  Write-Output ('BLE=' + $d.FriendlyName + ';' + $last)",
    "}",
    // 3) 蓝牙无线电状态
    "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
    "$m = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
    "$t = $m.MakeGenericMethod([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]]).Invoke($null, @([Windows.Devices.Radios.Radio,Windows.Devices.Radios,ContentType=WindowsRuntime]::GetRadiosAsync()))",
    "$t.Wait(5000) | Out-Null",
    "foreach ($r in $t.Result) { if ($r.Kind -eq 'Bluetooth') { Write-Output ('RADIO=' + $r.State) } }",
  ].join("; ");
  const out = run("powershell", ["-NoProfile", "-Command", script]);
  const bridges = (out.match(/BRIDGES=(.*)/)?.[1] ?? "").split("|").filter(Boolean);
  const bles = [...out.matchAll(/BLE=([^;]+);(.*)/g)].map((m) => ({ name: m[1].trim(), last: m[2].trim() }));
  const radio = out.match(/RADIO=(\w+)/)?.[1] ?? "未知";
  return { bridges, bles, radio };
}

function posixProbe() {
  const out = run("sh", ["-c", "ls /dev/ttyUSB* /dev/ttyACM* /dev/cu.usb* 2>/dev/null"]);
  return { bridges: out.split(/\s+/).filter(Boolean), bles: [], radio: "n/a" };
}

const { bridges, bles, radio } = isWin ? windowsProbe() : posixProbe();
const hm = bles.find((b) => /HMSoft|HM-10|HM10/i.test(b.name));
const recent = (s) => {
  const t = Date.parse(s.replace(/\//g, "-"));
  return Number.isFinite(t) && Date.now() - t < 30 * 60 * 1000; // 30 分钟内连过 = 认为在线
};

console.log("=== 真机就绪自检 ===");
console.log(`串口桥：${bridges.length ? bridges.join(" / ") : "（无）"}`);
console.log(`蓝牙无线电：${radio}`);
console.log(`已配对的 BLE 设备：${bles.length ? bles.map((b) => `${b.name}（最近连接 ${b.last || "—"}）`).join(" / ") : "（无）"}`);

const serialOk = bridges.length > 0;
const bleOk = Boolean(hm) && recent(hm.last) && radio === "On";
console.log("");
if (serialOk) console.log("[ok] 串口：可以跑  npm run hw:soak -- --kind=serial --minutes=30 --baud=<固件波特率>");
if (bleOk) console.log("[ok] BLE：可以跑  npm run hw:soak -- --kind=ble --minutes=30（对话框里选 HMSoft）");
if (!serialOk && !bleOk) {
  console.log("[!!] 两条通道都不可用：");
  if (!hm) console.log("     · 系统里没有 HMSoft 的配对记录 —— 先把 HM-10 上电并用系统蓝牙配对一次");
  else if (!recent(hm.last)) console.log(`     · HMSoft 最近一次连接是 ${hm.last}（不是刚才）—— 模块大概率没上电/不在范围/被手机占用`);
  if (radio !== "On") console.log("     · 蓝牙无线电是关的 —— 在 设置 → 蓝牙和其他设备 里打开");
  if (!serialOk) console.log("     · 没有 USB 串口桥 —— 插上 USB-TTL（CP210x/CH340/FTDI）或飞控转发再试");
  console.log("     上电后重跑  npm run hw:check  确认，再跑  npm run hw:soak。");
}
process.exit(serialOk || bleOk ? 0 : 1);
