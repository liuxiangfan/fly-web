# 真实 IMU 串口接入（GY-87 / MPU-9250 类模块）

本目录给出**帧协议规格**与参考实现要点。网页端（Web Serial）按这里的字节布局解析；
只要你的固件按同一格式发帧，就能在「IMU 传感器模拟 → 连接真实 IMU」里看到数据。

> 已验证硬件：STM32F4 + GY-87（MPU-6050 + HMC5883L/QMC5883L），USB 转串口，921600 8N1。
> `gy87.h` 是用户固件的接口头文件；本 README 是协议与移植说明。

---

## 1. 接线与串口

| 信号 | 建议引脚（STM32F4 示例） | 说明 |
|---|---|---|
| SCL | PB6（I2C1） | 400 kHz Fast Mode |
| SDA | PB7（I2C1） | 上拉到 3.3 V |
| TX | PA2（USART2_TX） | → USB 转串口 RX |
| RX | PA3（USART2_RX） | 可选（本协议只发不收） |
| GND | GND | 共地 |

- 串口：**921600 8N1，无流控**（推荐值）。网页端现在可在 9600–2000000 之间自选波特率——
  **固件设成什么，网页就选什么**，两边必须一致；连接期间该下拉会被锁定（Web Serial 在 open() 时固定端口参数），
  要换速率先断开。921600 对 CH340 一类桥接芯片可能不稳，调不通就降到 460800 或 115200（115200 足够跑 200 Hz）。
- 采样/发帧：建议 **200 Hz（5 ms 节拍）**；100–500 Hz 均可，网页按帧内 `tick` 自动算 dt。
- 帧总长 **28 字节**，小端。

## 2. 帧格式（与 `gy87.h` 一致）

```
偏移  长度  字段      类型     单位/说明
0     1     0xAA      u8       帧头 1
1     1     0x55      u8       帧头 2
2     1     24        u8       len：从 seq 到 mag 的字节数
3     2     seq       u16      帧序号，每帧 +1，u16 回绕
5     4     tick      u32      固件毫秒时基（HAL_GetTick / millis）
9     6     gyro      i16×3    0.1 °/s，机体系 x/y/z
15    6     accel     i16×3    0.01 m/s²，机体系 x/y/z
21    6     mag       i16×3    0.01 μT，机体系 x/y/z
27    1     crc8      u8       多项式 0x07，初值 0，覆盖 [2..26]（len 起到 CRC 前）
```

### 关键约定

1. **accel 符号**：静止时 z ≈ **+9.8**（读数 = 重力在机体系的投影，指向机体「下」）。
   网页端估计器按这个约定设计；若你的模块原始输出相反，请在固件里取反。
2. **坐标系**：NED 机体系（x 前、y 右、z 下）。模块丝印方向不一致时，网页端
   「安装方向」下拉会做四选一重排；也可以在固件里直接换算。
3. **tick** 必须单调递增（u32 毫秒）。网页用相邻 tick 差作为积分步长；
   丢帧/断流时自动退回名义 5 ms 并夹在 1–50 ms。
4. **seq** 用于丢帧统计：网页检测缺口并显示「seq 丢帧 N」。
5. gyro 量程 ±500 dps（i16 × 0.1 刚好覆盖 ±3276.7 dps）；accel ±4 g（0.01 m/s² 分辨率）；
   mag 0.01 μT 分辨率。

## 3. 组帧参考实现

```c
static uint8_t crc8(const uint8_t *d, uint16_t from, uint16_t to) {
  uint8_t crc = 0;
  for (uint16_t i = from; i < to; i++) {
    crc ^= d[i];
    for (int b = 0; b < 8; b++)
      crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x07) : (uint8_t)(crc << 1);
  }
  return crc;
}

static void put_i16(uint8_t *d, int off, float v, float scale) {
  int32_t x = (int32_t)lrintf(v * scale);
  if (x > 32767) x = 32767;
  if (x < -32768) x = -32768;
  uint16_t u = (uint16_t)(int16_t)x;
  d[off] = u & 0xFF;
  d[off + 1] = u >> 8;
}

void send_frame(uint16_t seq, uint32_t tick_ms,
                const float gyro[3], const float accel[3], const float mag[3]) {
  uint8_t d[28];
  d[0] = 0xAA; d[1] = 0x55; d[2] = 24;
  d[3] = seq & 0xFF; d[4] = seq >> 8;
  d[5] = tick_ms & 0xFF; d[6] = (tick_ms >> 8) & 0xFF;
  d[7] = (tick_ms >> 16) & 0xFF; d[8] = (tick_ms >> 24) & 0xFF;
  for (int i = 0; i < 3; i++) {
    put_i16(d, 9 + 2 * i, gyro[i], 10.0f);
    put_i16(d, 15 + 2 * i, accel[i], 100.0f);
    put_i16(d, 21 + 2 * i, mag[i], 100.0f);
  }
  d[27] = crc8(d, 2, 27);
  HAL_UART_Transmit(&huart2, d, 28, 5);
}
```

主循环：

```c
uint32_t next = HAL_GetTick();
uint16_t seq = 0;
while (1) {
  if ((int32_t)(HAL_GetTick() - next) >= 0) {
    next += 5;  // 200 Hz
    read_mpu6050(gyro_dps, accel_ms2);
    read_hmc5883l(mag_ut);
    send_frame(seq++, HAL_GetTick(), gyro_dps, accel_ms2, mag_ut);
  }
}
```

> 读取 + 发帧总耗时必须小于 5 ms；若 I2C 较慢，可降到 100 Hz（`next += 10`），
> 网页会自动按 tick 调整积分步长。

## 4. 网页端连接步骤

1. Chrome / Edge 打开演示页（HTTPS 或 localhost）。
2. 面板「IMU 传感器模拟」→「连接真实 IMU」→ 在浏览器弹窗里选串口设备。
3. 状态行出现 `真实 IMU · N 帧/s · dt x.x ms · seq 丢帧 0` 即成功。
4. 如果姿态方向不对：切换「安装方向」四选一（页面会清空半解析缓冲，防止错位）。
5. 真实模式没有姿态真值：3D 幻影隐藏，误差曲线改以 Mahony 为参照；
   模拟剧本/噪声滑块会置灰（它们不影响串口数据）。
6. 磁力计读数受机身金属影响时，用面板里的「磁力计校准」：缓慢翻滚机体采集
   240+ 点，点「拟合并应用」——硬铁球心与对角软铁会被解出并实时应用到 MARG。

## 5. 排障

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 浏览器没有串口设备 | 非 Chrome/Edge、非 HTTPS/localhost | 换浏览器或用 `localhost` |
| 打开端口失败 | SerialWeb/串口助手仍占用 | 先断开其它工具 |
| 连上但无数据 | 固件没发帧 / **波特率与网页端不一致** / TX-RX 接反 | 用 SerialWeb 先看十六进制 0xAA 0x55；确认两边波特率相同 |
| 帧率正常但姿态乱 | 安装方向错 / accel 符号反 / 坐标系不是 NED | 调「安装方向」；确认静止 accel z≈+9.8 |
| 丢帧持续增长 | 主循环超时 / UART 阻塞发送 / 波特率过高而桥接芯片跟不上 | 用 DMA、降低采样率；若帧率正常但 seq 缺口大，**降低**波特率试试 |
| 磁航向乱跳 | 硬铁/软铁干扰、电机磁场 | 做磁校准；远离电机/扬声器 |
| 网页状态行「数据流中断」 | 固件卡死或线缆松动 | 看固件是否仍在发 tick；重连 |

## 6. 与网页端解析器的一致性

`src/core/serial.ts` 是同一份协议的纯函数实现，`npm run selftest` 中有往返/坏 CRC/
粘包重同步/安装方向四项断言。改协议时两边一起改，并同步本 README 的字节表。
