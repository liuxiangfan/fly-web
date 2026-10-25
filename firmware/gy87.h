/*
 * gy87.h — GY-87（MPU-6050 + HMC5883L/QMC5883L）串口输出模块（STM32 HAL）
 *
 * 用法（CubeIDE）：
 *   1. CubeMX：I2C1 = Fast Mode 400kHz（PB6=SCL / PB7=SDA）、USART2 = 921600 8N1（PA2=TX → USB 转串口）
 *   2. 把 gy87.c/h 加入工程，在 main.c 里：
 *        #include "gy87.h"
 *        Gy87_Init(&hi2c1, &huart2);
 *        while (1) { Gy87_Task(); }          // 内部按 5ms 节拍自定时（200Hz）
 *   3. 烧录后用 SerialWeb（或任意串口工具）按 921600 打开，验证帧格式
 *
 * 帧格式（小端，共 28 字节）：
 *   [0]=0xAA [1]=0x55 [2]=len=24
 *   [3..4]  seq    u16   帧序号
 *   [5..8]  tick   u32   HAL_GetTick() 毫秒
 *   [9..14] gyro   i16×3 0.1 °/s（±500dps 量程）
 *   [15..20] accel i16×3 0.01 m/s²（±4g 量程）
 *   [21..26] mag   i16×3 0.01 μT
 *   [27]    crc8   多项式 0x07，覆盖 [2..26]（len 起到 CRC 前）
 */
#ifndef GY87_H
#define GY87_H

#include "stm32f4xx_hal.h"

typedef struct {
  float gyro_dps[3];   /* °/s，机体系（模块安装方向即机体方向） */
  float accel_ms2[3];  /* m/s²，静止时 z ≈ +9.8（NED 模块平放） */
  float mag_ut[3];     /* μT */
  uint32_t tick_ms;
} Gy87_Data;

HAL_StatusTypeDef Gy87_Init(I2C_HandleTypeDef *hi2c, UART_HandleTypeDef *huart);
void Gy87_Task(void);          /* 在主循环里不停调用：内部按 5ms 节拍读传感并发帧 */
const Gy87_Data *Gy87_Last(void);

#endif
