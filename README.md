# 四元数姿态解算 · 学习演示装置

一个纯浏览器运行的交互式教学演示:模拟 IMU 传感器数据,实时运行四种姿态解算算法并对比误差,配合可操作的 3D 平衡环架直观展示**万向节锁(Gimbal Lock)**,帮助理解飞控/姿态估计中"为什么用四元数"以及"互补滤波 / Mahony / Madgwick 各自在做什么"。

## 在线演示

> 每次推送到 `master` 自动部署（GitHub Actions → Cloudflare Workers）：
> **https://quaternion-attitude-demo.liu06167492.workers.dev**

## 功能特性

### 四轴姿态视图

- **模拟 IMU**:可实时调节陀螺零偏 / 陀螺噪声 / 加计噪声 / 机动线加速度污染 / 电机振动,观察各因素对解算的影响
- **四种解算算法实时对比**:纯陀螺积分(演示漂移)、互补滤波、Mahony、Madgwick,参数(Kp / Ki / β / α)均可在线调节
- **3D 四轴飞行器模型**:可切换显示"真实姿态"或任一算法的解算姿态,真实姿态以线框幻影叠加显示,姿态偏差一目了然
- **机动剧本**:悬停微扰、手动控制(滑块直接设定目标姿态)、横滚 360°、俯仰摆动、复合机动、剧烈机动
- **实时曲线**:欧拉角三通道曲线 + 姿态总误差曲线(解算 vs 真实),自绘 Canvas 实现,无图表库依赖
- **原理速览**:内置"为什么要用四元数""陀螺仪为什么积分会漂移""三种融合算法的直觉"等折叠讲解

### 万向节锁视图

- 可拖拽滑块独立驱动的**三轴平衡环架**(偏航 / 俯仰 / 横滚),环标签随环转动
- 把俯仰拖到 ±90° 时内环与外环转轴重合,两环**变红报警**——直观呈现"只剩 2 个自由度"
- 一键完整演示:先用横滚再用偏航各转 60°,对比两次最终姿态,理解欧拉角的非交换性;演示可随时**暂停**在任意姿态

### 通用

- **玻璃盒（算法内部可视化）**:可开关。3D 中以双箭头展示"算法预测的重力方向"(白)与"加计实测的重力方向"(品红)——收敛时重合,纯积分时白箭头持续转偏(漂移的直观形态);面板同步显示陀螺输入与修正量、Mahony 的 Kp/Ki 占比条、Madgwick 的梯度残差;剧烈机动导致加计受扰时会自动降饱和并给出提示
- 暂停 / 重置、视图拖拽旋转与滚轮缩放
- 纯前端、零后端、零密钥,所有计算在浏览器本地完成

## 技术栈

- [Three.js](https://threejs.org/)(r170)——3D 场景渲染,唯一运行时依赖
- TypeScript + Vite
- 无前端框架,无图表库(曲线为手写 Canvas 绘制)

## 快速开始

```bash
git clone https://github.com/liuxiangfan/fly-web.git
cd fly-web
npm install

npm run dev       # 开发服务器
npm run build     # 产出 dist/(tsc 类型检查 + vite 构建)
npm run preview   # 本地预览构建产物
npm run check     # 数值自测 + 场景自检(selftest + scenecheck)
```

## 项目结构

```
├── index.html              # 页面骨架与全部 UI 文案(含原理速览)
├── src/
│   ├── main.ts             # 入口:装配模拟、解算、场景、UI 与主循环
│   ├── core/
│   │   ├── quat.ts         # 四元数运算
│   │   ├── imu.ts          # IMU 仿真(零偏 / 噪声 / 线加速度 / 振动)
│   │   ├── scenarios.ts    # 机动剧本
│   │   ├── world.ts        # 仿真世界:真值传播与传感器输出
│   │   ├── gimbal.ts       # 万向节锁运动学
│   │   └── rng.ts          # 可复现随机数
│   ├── estimators/
│   │   └── index.ts        # 纯积分 / 互补 / Mahony / Madgwick 四种解算器(含内部量遥测)
│   ├── scene/
│   │   ├── quad.ts         # 四轴飞行器模型
│   │   ├── gimbal.ts       # 平衡环架模型
│   │   ├── labels.ts       # 环标签
│   │   └── setup.ts        # 场景 / 灯光 / 相机初始化
│   └── ui/
│       ├── chart.ts        # 手写 Canvas 姿态与误差曲线
│       └── mode.ts         # 视图(四轴姿态 / 万向节锁)状态与文案
├── scripts/
│   ├── selftest.ts         # 解算算法数值自测
│   ├── scenecheck.ts       # 场景装配自检
│   └── diag*.ts            # 调试脚本
└── wrangler.jsonc          # Cloudflare Workers 部署配置(静态资产)
```

## 坐标系与约定

- 世界系为 **NED**(x 北、y 东、z 下),机体系 **x 前、y 右、z 下**,因此场景中 z 轴箭头指向地面
- 四元数 `q` 表示**机体系 → 世界系**的旋转,模拟加速度计静止时输出 +g 沿机体"下"方向
- 姿态解算频率 500 Hz,曲线每 40 ms 记录一点

## 部署

构建产物为纯静态文件(`dist/`),任意静态托管均可:

**Cloudflare Workers**(本仓库已含 `wrangler.jsonc`):

```bash
npm run build
npx wrangler deploy
```

**GitHub Pages / Vercel / Netlify / 自己的 nginx**:上传 `dist/` 内容即可;若部署在子路径下,需在 Vite 配置中设置 `base: './'` 后重新构建。
