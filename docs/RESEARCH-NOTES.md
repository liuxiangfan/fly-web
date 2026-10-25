# 外部资料汇编 · 四元数姿态解算项目改进参考

> **生成**：2026-10-25 · 四条并行调研线（数学教学与可视化 / 算法论文与教程 / 开源实现与官方文档 / 教学设计与传感器实践），共 47 条资源。
> **用途**：交给后续模型完善本项目时直接阅读。关键内容（公式、参数、流程）已内联摘录，**无需联网即可使用**；需要原文时再点 URL。
> **验证**：全部条目于 2026-10-25 实际打开核实过正文（PDF 下载全文提取 / 网页抓取）；个别打不开的原始链接已换成可达镜像并注明。视频类未能逐帧核实的单独标注。

---

## 0. 给接手模型的说明

1. **先读 [`docs/PROJECT-STATE.md`](PROJECT-STATE.md)**：它是项目恢复锚点（架构、约定、验证体系、已完成里程碑）。本文件是它的资料补充，不重复项目现状细节。
2. 本文件结构：§1 项目速览 → §2–§5 四类资源条目（A/B/C/D 编号）→ §6 综合改进建议（P1/P2/P3 优先级，引用条目编号）→ §7 速查索引。
3. 条目里的「结合点」都已对照项目模块（`src/estimators`、`src/scene/quatview.ts`、文档页各章节）；公式为来源原文摘录，可直接用于核对或扩写项目文档。
4. **一个重要结论先说**：算法调研线对项目已实现的公式（Mahony 叉积误差符号、互补滤波倾斜补偿航向、ES-EKF 误差状态结构、NED 口径、磁倾角/场强量级）逐条对照过文献，**未发现错误**；可深化点见 §6。

---

## 1. 项目现状速览

- **是什么**：纯前端（Vite + TypeScript + Three.js ^0.170，无后端）的四轴无人机四元数姿态解算教学演示装置。已部署 `fly_web.070616.xyz`（GitHub Actions → Cloudflare Workers）。
- **功能面**：3D 姿态可视化（真机 + 各估计器幻影）· 模拟 IMU（陀螺零偏/白噪声、加计振动/线加速度扰动、磁力计硬铁/磁倾角 49°/~50μT/交变干扰）· **5 种解算算法同屏对比**（纯陀螺仪积分 / 互补滤波含倾斜补偿航向 / Mahony MARG / Madgwick MARG / 误差状态卡尔曼 ES-EKF：6 维 [δθ(3),δb(3)]、重力+磁场观测、40° 新息门控、零偏在线估计）· 万向节锁平衡环架演示 · 四元数视图（参考球上 Slerp vs 欧拉角插值双弧线 + **4D 立体投影模式**：S³ 从南极 (−1,0,0,0) 投影到 R³，q/−q 倒易点对）· 应用内中文文档页（控制项百科 / 零基础数学推导 / 滤波算法讲解 / 工程实践）。
- **坐标约定**：世界 NED、机体 FRD，q 为机体系→世界系；显示坐标 NED→显示 S=Rx(90°)。
- **项目已有外部参考**：i2Nav《惯性导航姿态算法》讲义、i2Nav KF-GINS、eater.net/quaternions、euclideanspace、UIUC 四元数笔记、北航 Rfly 课程（本汇编未重复收录，但部分条目作了深挖补充）。
- **项目待办方向**（资料若能支撑更佳）：A/B 参数对比、IMU 误差模型升级（Allan 方差级噪声）、闭环控制演示、深链分享。

---

## 2. 四元数数学教学与可视化（A 线，12 条）

### [A1] Wikipedia: Quaternions and spatial rotation
- URL: https://en.wikipedia.org/wiki/Quaternions_and_spatial_rotation
- 类型: 公式页（全文已核实）
- 一句话定位: 四元数旋转最全面的单页参考，含证明、矩阵、可视化论述与性能对比表。
- 关键内容摘录:
  - 轴角定义：绕单位轴 (X,Y,Z) 转 θ 对应 q = (C, X·S, Y·S, Z·S)，其中 C = cos(θ/2)、S = sin(θ/2)；旋转作用于向量用共轭 p′ = q p q⁻¹（Hamilton 乘积）。
  - 双倍覆盖的几何证明：绕 u 转 θ 与绕 −u 转 2π−θ 是同一终姿态的两条不同路径，代入公式分别得 q 与 −q；代数上共轭对 q 是二次型，符号自动消去。SU(2)→SO(3) 为 2:1 映射；半转（θ=π）时 q 与 −q 实部均为 0。
  - 「旋转超球面」章节：北极=恒等旋转，纬度=转角的一半，赤道=180°，继续向南半径收缩，南极=恒等旋转再现；每个旋转由球面对径两点表示（双倍覆盖）。
  - 万向节锁论述：球面可用经纬度两参数化，但极点退化（毛球定理）；推广到三维——任何三角度（欧拉角）参数化在超球面上必有退化点，即 gimbal lock；用四坐标 w²+x²+y²+z²=1 可避免。
  - 性能表：旋转链式复合四元数 16 乘 12 加 = 28 次，矩阵 27 乘 18 加 = 45 次；单向量旋转矩阵反而最快（9 乘 6 加）。
  - Hamilton 约定 vs Shuster/JPL 约定对照表（ij=k vs ij=−k，旋转公式叉积符号翻转，旋转矩阵互为转置），并列出 Eigen/ROS/SciPy/Ceres 用 Hamilton、DirectX 用 Shuster。
- 结合点: 「为什么恰好是四个数」与 S³ 视图的文档章节可引用超球面「纬度=半角、南北极同为恒等」的表述；约定对照表可补进控制项百科；性能表可写进算法对比文档。

### [A2] Wikipedia: Slerp
- URL: https://en.wikipedia.org/wiki/Slerp
- 类型: 公式页（全文已核实）
- 一句话定位: Slerp 权威条目，几何/四元数两套公式、双倍覆盖路径处理与递推加速齐全。
- 关键内容摘录:
  - 几何公式（Glenn Davis）：slerp(p₀,p₁;t) = [sin((1−t)Ω)/sinΩ]·p₀ + [sin(tΩ)/sinΩ]·p₁，cosΩ = p₀·p₁；对称性 slerp(p₀,p₁;t) = slerp(p₁,p₀;1−t)；Ω→0 退化为 lerp。
  - 等步长快速递推：pₖ₊₁ = c·pₖ − pₖ₋₁，其中 c = 2·dot(pₖ₋₁,pₖ) 为常数——每次只需一次乘加，O(1)。
  - 双倍覆盖与长/短路径：q 与 −q 映射到同一旋转；若 cosΩ < 0 将一端取负即可强制短路径，保证 −90° ≤ Ω ≤ 90°。
  - 四元数指数形式：单位四元数 q = cosΩ + v·sinΩ 满足 qᵗ = cos(tΩ) + v·sin(tΩ)，群形式由 q = q₁q₀⁻¹ 的实幂生成。
  - 导数性质：∂slerp/∂t = log(q₁q₀⁻¹)·函数值，四元数对数恰好给出**一半**三维角速度向量——与 q̇=½q⊗ω 推导同源。
- 结合点: 四元数视图 Slerp 双弧线对比的公式出处；递推公式可用于参考球等间隔采样优化；「导数=半角速度」可写进 q̇=½q⊗ω 推导页作交叉验证练习。

### [A3] Wikipedia: Conversion between quaternions and Euler angles
- URL: https://en.wikipedia.org/wiki/Conversion_between_quaternions_and_Euler_angles
- 类型: 公式页（全文已核实）
- 一句话定位: 四元数↔欧拉角双向转换的完整公式库，含可直接抄写的代码与奇点处理。
- 关键内容摘录:
  - 采用 Tait–Bryan z-y′-x″ 内旋序列（航空 Body 3-2-1：heading ψ 绕 Z、pitch θ 绕新 Y、bank φ 绕新 X），X 前 Y 右 Z 向下——与项目 NED 航空约定完全一致。
  - 欧拉→四元数（已核实代码）：q.w = cr·cp·cy + sr·sp·sy；q.x = sr·cp·cy − cr·sp·sy；q.y = cr·sp·cy + sr·cp·sy；q.z = cr·cp·sy − sr·sp·cy（cr=cos(roll/2) 等缩写）。
  - 四元数→欧拉（已核实代码）：roll = atan2(2(q.w·q.x + q.y·q.z), 1−2(q.x²+q.y²))；pitch = 2·atan2(√(1+2(q.w·q.y−q.x·q.z)), √(1−2(q.w·q.y−q.x·q.z))) − π/2；yaw = atan2(2(q.w·q.z + q.x·q.y), 1−2(q.y²+q.z²))。
  - 明确指出 pitch→±90° 奇点即 gimbal lock，须特判；atan2 替代 arctan 为覆盖全象限。
  - 向量旋转交叉积加速式 v′ = v + 2w(r×v) + 2r×(r×v)，比完整两次四元数乘法快约 30%（Janota et al. 2015 实测）。
- 结合点: 项目模拟 IMU 与估计器的姿态↔欧拉角显示可对照此表核对；数值更稳定的 pitch 公式值得检查项目 `qToEuler` 现有实现；交叉积加速式可写进性能小节。

### [A4] Allen Chou《Game Math: Deriving the Slerp Formula》
- URL: https://allenchou.net/2018/05/game-math-deriving-the-slerp-formula/
- 类型: 博客教程（正文已核实）
- 一句话定位: 从纯向量几何出发 10 步推出 slerp 公式，不依赖四元数代数。
- 关键内容摘录:
  - 出发点：slerp 沿最短弧插值两个向量；t=0.25 即「弧上 25% 路径点」。
  - 推导策略：构造正交基 x̂ = a，ŷ = normalize(b − (a·b)a)，套参数化圆公式 c = cos(tΩ)·x̂ + sin(tΩ)·ŷ，展开即得标准两项式。
  - 公式对单位四元数（4D 超球面最短弧）同样成立；Eric Lengyel《Mathematics for 3D Game Programming and CG》3rd ed §4.6.3 有「相似三角形」第二种推导。
- 结合点: 项目文档已有 Slerp 推导，此文提供更几何化（先正交分解后合成）的等价讲法，适合做成参考球上的辅助线动画（画出 ŷ 分量）。

### [A5] Ken Shoemake《Animating Rotation with Quaternion Curves》(SIGGRAPH '85)
- URL: https://courses.cs.duke.edu/fall01/cps124/resources/p245-shoemake.pdf （PDF 已核实 10 页全文；官方 DOI 页 https://dl.acm.org/doi/10.1145/325165.325242 ）
- 类型: 原始论文（讲义类）
- 一句话定位: Slerp 的开山之作，S³ 大圆弧插值与旋转拓扑直觉的原始出处。
- 关键内容摘录:
  - 原始公式（§3.3 Great arc in-betweening，原文已核实）：群形式 Slerp(q₁,q₂;u) = q₁(q₁⁻¹q₂)ᵘ；几何形式 = [sin((1−u)θ)/sinθ]·q₁ + [sin(uθ)/sinθ]·q₂，其中 q₁·q₂ = cosθ；并注明「前者利于分析，后者利于编程」。
  - 明确论证 S³ 是四元数群的子群，且 S³ 的球面度量 = SO(3) 的角度量，故球面上走大圆弧 = 匀角速旋转。
  - §3.4 拓扑论述（原文已核实）：「几何弯曲如球面，但拓扑说南北极是同一点！每一对对径点表示同一旋转」；并用「书翻转实验」类比非交换性。
- 结合点: 四元数视图双弧线对比可引用「q₁⁻¹q₂ 是从 q₁ 到 q₂ 的相对旋转」表述；S³=SO(3) 度量对应关系是 4D 投影模式文档缺的一环。

### [A6] Dam, Koch, Lillholm《Quaternions, Interpolation and Animation》(DIKU-TR-98/5)
- URL: https://web.mit.edu/2.998/www/QuaternionReport1.pdf （PDF 103 页，已核实；哥本哈根大学技术报告，MIT 课程页镜像）
- 类型: 讲义（技术报告）
- 一句话定位: 103 页四元数旋转与插值专著，唯一给出 Slerp 与 Squad **完整正确性证明**的公开讲义。
- 关键内容摘录:
  - 目录已核实：§2 几何变换、§3 两种旋转模态（欧拉角/矩阵/四元数对比，含历史、基本代数、指数对数、几何直觉、微分学），后部为插值方法专章。
  - 对 Slerp 和 Squad 的正确性给出完整证明；自创「Spring」插值法（由最优插值曲线的约束导出微分方程组，给数值解）；最后对 Spring 与 Squad 系统对比。
  - 图形学界引用最广的四元数进阶标准读物。
- 结合点: 若文档页想加「Squad/多关键帧插值」扩展章节，此报告是现成蓝本；「几何直觉」一节可校对项目 q̇=½q⊗ω 推导的术语。

### [A7] Marc ten Bosch《Let's remove Quaternions from every 3D Engine》（Interactive Rotors）
- URL: https://marctenbosch.com/quaternions/
- 类型: 交互文章（章节结构与交互细节已核实；站点对 curl 返回 406 反爬，浏览器访问正常）
- 一句话定位: 用几何代数 rotor（两次反射=旋转）重构旋转直觉的著名交互长文，Miegakure 作者出品。
- 关键内容摘录:
  - 章节结构（已核实）：Planes of Rotations（旋转发生在 2D 平面内）→ Bivectors（外积、基、2D/3D 二重向量）→ The Geometric Product（乘法表、反射公式、两次反射=旋转、Rotors、3D Rotors vs Quaternions）→ Further Reading / History。
  - 核心论点：「叉积生成平面的法向量，外积 a∧b 生成平面本身——取法向量是多余的」；旋转只作用于平面内分量 v∥，v⊥ 不动。
  - 指出 3D 中 bivector 与 vector 恰好同为 3 分量是三维独有的巧合，正是历史上把二者混淆的根源。
  - 交互设计（已核实）：3D 场景拖拽转相机；反射演示可拖动向量端点、按步执行每次反射（"apply each successive Reflection Step"）、Reset 按钮。
  - 注意（核实结论）：全文**不**讨论双倍覆盖/负四元数问题，只讲 rotor 与四元数同构、分量与 API 相同。
- 结合点: 「两次反射=旋转」分步演示极适合搬进数学文档（Three.js 里对向量做 v∥/v⊥ 分解着色 + 单步按钮）；「旋转发生在平面内」是比「绕轴旋转」更准的教学表述。

### [A8] Krasjet《四元数与三维旋转》（中文）
- URL: https://github.com/Krasjet/quaternion （在线版 https://krasjet.github.io/quaternion/ ；仓库内 quaternion.pdf 与 bonus_gimbal_lock.pdf）
- 类型: 中文讲义（PDF + GitHub 仓库，README 与文件结构已核实）
- 一句话定位: GitHub 2.1k star 的中文四元数入门标准文献，从复数推广几何化推导，附 Bonus 万向节锁专章。
- 关键内容摘录:
  - 仓库结构（已核实）：正文 quaternion.pdf + Bonus《Gimbal Lock 的产生》单独 PDF（2025-07-16 更新说明注明「重写 Gimbal Lock 章节」）+ 附录 2「左手坐标系统下的旋转」+ demo/ 目录含 MATLAB（可 Octave 运行）演示脚本与导出 GIF。
  - 定位：以基础几何与线性代数推导四元数与三维旋转的关系，不引入高深代数；在线版为 JS 渲染壳，正文以 PDF 为主。
  - 作者自述年代较早「错误可能会有很多」，欢迎 Issues 勘误。
- 结合点: 项目文档页的最佳中文前置读物（可加「延伸阅读」链接）；其 MATLAB demo→GIF 工作流值得模仿；Bonus 章可与项目万向节锁平衡环架演示互相引证。

### [A9] Matthew Brett《Gimbal lock》（transforms3d 文档）
- URL: https://matthew-brett.github.io/transforms3d/gimbal_lock.html
- 类型: 讲义（全文已核实）
- 一句话定位: 用旋转矩阵代数把万向节锁「算给你看」的最短讲义，含可复现的 NumPy 数值实验。
- 关键内容摘录:
  - 数学核心（已核实）：sxyz 约定下当 cos(β)=0（β=±π/2）时，组合矩阵中的 α、γ 总以 (α+γ) 组合出现——W₁ = sinα·cosγ + sinγ·cosα = sin(α+γ)，W₂ = cosα·cosγ − sinα·sinγ = cos(α+γ)，故 α 与 γ 数学上不可区分，自由度 3→2。
  - Spitfire 数值例：euler2mat(−0.2, −π/2, −0.2, 'sxyz')，把 x 角 +0.1、z 角 −0.1 得到**完全相同**矩阵；euler2mat(x+z, y, 0) 与原矩阵 np.allclose 为 True。
  - 解法演示：换 'sxzy' 序列可避开；再用 mat2euler 换回 sxyz 得 (≈1.371, −1.371, −1.571)。
  - 注意：页面**未**从拓扑上论证「三参数必有奇点」（该论证见 A1）。
- 结合点: 万向节锁演示页可加「矩阵证据」折叠块，复刻其 α±δ/γ∓δ 同矩阵实验（纯 JS 即可）；与 A1 的拓扑论证互补成「代数现象 + 拓扑必然」完整故事。

### [A10] Quaternions Online（交互转换器）
- URL: https://quaternions.online/
- 类型: 交互演示（页面 HTML 骨架已核实，运行时行为未实测）
- 一句话定位: 浏览器内四元数/欧拉角/轴角三向对照的最简在线工具。
- 关键内容摘录:
  - 已核实界面功能：四元数 (w,x,y,z) 与欧拉角 (x,y,z) 双向输入联动；旋转顺序可选 XYZ / ZYX / YZX；Degrees/Radians 切换；"Apply Rotation"；"Show axis of rotation" 开关在 3D 视图中叠加显示等效旋转轴；"Animation" 播放从单位到目标姿态的动画；WebGL 渲染。
- 结合点: 「Show axis of rotation」值得借鉴——在项目姿态视图叠加等效欧拉轴箭头（四元数向量部分方向）；多旋转顺序切换可对照欧拉角插值弧线的顺序敏感性。

### [A11] Numberphile《Fantastic Quaternions》
- URL: https://numberphile.com/videos/fantastic-quaternions （官方页已核实；正片 YouTube 未逐帧验证；加长片段 https://youtu.be/ISbJ9S0fzwY 已核实）
- 类型: 视频（James Grime 主讲，2016，约 110 万播放）
- 一句话定位: 面向大众的四元数科普视频，从复数乘法讲清「为什么三个数不行、四个数恰好」。
- 关键内容摘录:
  - 官方页文案（已核实）：复数表示 2D 旋转 → Hamilton 1843 年在都柏林桥刻下 i²=j²=k²=ijk=−1 → 三元组失败的代数原因 → 四元数乘法表 → 三维旋转应用（内容线经多来源交叉确认）。
- 结合点: 「为什么恰好是四个数」章节的配套通俗视频；「三元组失败」的故事可作文档开篇引子。

### [A12] 《Möbius Transformations Revealed》（Arnold & Rogness）
- URL: https://www.ima.umn.edu/~arnold/moebius/ （官方页已核实；配套论文发表于 Notices of the AMS 2008-11）
- 类型: 视频（明尼苏达大学 IMA，2007，早期数学视频爆款）
- 一句话定位: 把 Möbius 变换「抬升」到黎曼球面上用球面投影拍摄的 2 分钟经典——立体投影直觉的最佳镜头语言范本。
- 关键内容摘录:
  - 核心镜头设计（官方页与配套论文交叉确认）：平面先整体上抬为彩格黎曼球 → 变换表现为**球在自身上滚动/缩放/旋转** → 再立体投影落回平面，圆→圆、共形性一目了然；「抬升-变换-投影」三段式是讲立体投影的标准叙事。
  - 与四元数的联系：S³ 上的四元数插值经立体投影到 R³ 的画面可完全复用此镜头语言。
- 结合点: 4D 立体投影模式文档可直接引用此视频作直觉铺垫；「抬升-变换-投影」可做成项目内三按钮分步动画（先 S³ 弧线、再投影、最后合成）。

---

## 3. 姿态解算算法：论文与深度教程（B 线，13 条）

### [B1] Madgwick 2011 内部报告（完整 32 页版）
- URL: https://github.com/art1/FloatSat-Project-G9/blob/master/madgwick_internal_report.pdf （已下载核实全文；**官方 x-io.co.uk 原链已死**）。配套精简版（ICORR 2011 会议论文 7 页）：https://vigir.missouri.edu/~gdesouza/Research/Conference_CDs/RehabWeekZ%C3%BCrich/icorr/papers/Madgwick_Estimation%20of%20IMU%20and%20MARG%20orientation%20using%20a%20gradient%20descent%20algorithm_ICORR2011.pdf
- 类型: 论文（技术报告）
- 一句话定位: 梯度下降姿态滤波的原始文献，含 IMU/MARG 两版推导与全部常数定义。
- 关键内容摘录:
  - 目标函数（eq 15）：f(q̂, d̂, ŝ) = q̂⊗d̂⊗q̂* − ŝ；梯度（eq 20）：∇f = Jᵀ(q̂,d̂)·f，J 为 3×4 雅可比（eq 22 全式，元素形如 2dx(q₃q₄−q₁q₂)）。
  - 更新：q_{k+1} = q_k − μ·∇f（eq 19）；每步只做 1 次迭代（μ=β·Δt），μ 由「陀螺发散率 = 梯度收敛率」最优融合推出（eq 37-38）。
  - **β 物理含义（eq 50）：β = √(3/4)·ζ̄**，ζ̄ 为零均值陀螺误差（白噪声+混叠+量化+标定残差）的模长，单位 rad/s，直接决定滤波带宽；MARG 第二参数 γ = √(3/4)·ζ̇̄（eq 51）用于零偏收敛。
  - 磁畸变补偿（eq 45-46）：h = q̂⊗m⊗q̂*，参考磁方向强制 b = [√(hx²+hy²), 0, hz]，即把磁干扰限制为只影响偏航——与项目「磁误差并入 z 分量」同源。
  - 零偏漂移补偿（eq 47-49，仅 MARG）：ω̂ = 2·q̂*_{t−1}⊗q̂̇_err 反解角误差向量，b̂ ← b̂ + ζ·ω̂·t，补偿后 ω_c = ω − b̂。
  - 计算量：每次更新 **109（IMU）/ 277（MARG）** 次标量运算；精度 <0.6°静态 / <0.8°动态 RMS；可用至 10 Hz 采样率。
- 结合点: ① Madgwick 文档页「梯度碗」章节可补 Jᵀf 完整展开与 109/277 运算数（项目 500 Hz 定步长下有明确意义）；② β=√(3/4)ζ̄ 可把 β 滑块换算成陀螺噪声物理量；③ eq 45-46 可对照磁干扰演示「交变干扰只污染航向」现象。

### [B2] Joan Solà《Quaternion kinematics for the error-state Kalman filter》
- URL: https://arxiv.org/abs/1711.02508 （arXiv v1 长版 95 页，已下载核实）
- 类型: 论文（arXiv 长文讲义）
- 一句话定位: ESKF/流形卡尔曼最系统的四元数推导，F/H 雅可比与注入-重置的权威出处。
- 关键内容摘录:
  - 真状态 = 名义态 ⊗ 误差态：q_t = q⊗q(δθ)；名义态高频积分（不含噪声），误差态是小信号线性系统由 ESKF 估计；误差态均值注入名义态后重置为零。
  - 误差运动学（eq 238）：δθ̇ = −[ω_m−b̂_g]×δθ − δb_g − n_g（姿态+陀螺零偏子集，正是项目 KalmanEstimator 的结构）；完整版还有 δv̇、δb_a 方程。
  - 传递矩阵 F（eq 270）可取一阶欧拉 Φ≈I+FΔt 或矩阵指数/RK4（附录 B-D 三种精化）；**Fi·Qi·Fiᵀ 协方差增长「绝不能跳过」**（原文明示预测方程可注释、协方差预测不能省）。
  - 观测雅可比链式法则（eq 278）：H = H_x·X_{δx}；四元数块（eq 281）：Q = ½·[−q_x −q_y −q_z; q_w −q_z q_y; q_z q_w −q_x; −q_y q_x q_w]。
  - 注入（eq 282-283）：q ← q⊗q{δθ̂}；重置附带的协方差修正与 Joseph 形式数值稳定（脚注 26：P←(I−KH)P(I−KH)ᵀ+KVKᵀ）。
- 结合点: ① 项目 KalmanEstimator 的 6 维 [δθ,δb] 正是 Solà 15 维框架取姿态+陀螺零偏子集，δθ̇ 一行可直接对照；② H 的重力观测雅可比可用 eq 281 精确写出（若项目用数值微分可换解析式）；③ 注入后协方差重置修正是可核对的可选深化点。

### [B3] Markley《Multiplicative vs. Additive Filtering for Spacecraft Attitude Determination》
- URL: https://ntrs.nasa.gov/api/citations/20040037784/downloads/20040037784.pdf （NASA NTRS；curl 403 但浏览器可开，已经网页阅读器核实全文）
- 类型: 论文（NASA 技术报告，Goddard，2003）
- 一句话定位: 论证乘性（MEKF）优于加性 EKF 的经典决策文献。
- 关键内容摘录:
  - 加性 EKF 三缺陷：四元数四维超定 → E{q} 模长 <1（归一化破坏）；「角度+模长」不确定度纠缠；小姿态误差下本征值问题病态。
  - MEKF：q = q_ref ⊗ δq(δa)，δa 三分量最小参数化，q_ref 由定义归一，无奇异。
  - 陀螺量测模型 ω̂ = b̂ + ω + n，量测敏感度 H = −[b̂_B×]；连续观测下无需重置。
  - 结论：加性仅在 180° 大误差恢复场景有意义，常规场景推荐乘性。
- 结合点: ① 支撑项目「乘性误差状态」选型的权威引用；② 可写入文档「卡尔曼详解」页作为 MEKF vs 加性 EKF 对比框；③ H=−[b̂×] 可对照项目陀螺零偏观测实现。

### [B4] Mahony 2008 显式互补滤波（原文的公式级复述 + 参考实现）
- URL: https://ahrs.readthedocs.io/en/latest/filters/mahony.html （已核实公式与默认参数）。原论文《Nonlinear Complementary Filters on the Special Orthogonal Group》权威页 https://hal.science/hal-00488376v1/document 被反爬拦截（ANU 副本亦需登录），**原文 PDF 未能直接验证**，公式经上述文档交叉核实。
- 类型: 文档（开源 ahrs 库按原论文推导复述）
- 一句话定位: Mahony/Hamel/Pflimlin 2008 TAC 论文的公式级复述 + 参考实现。
- 关键内容摘录:
  - 显式互补滤波四元数形式：q̇̂ = ½q̂⊗p(Ω_y − b̂ + k_P·e)；ḃ̂ = −k_I·e；e = Σᵢ kᵢ vᵢ×v̂ᵢ（测量方向×估计方向叉积误差，v̂ᵢ = q̂⊗vᵢ_ref⊗q̂*）。
  - 默认增益 k_P=1.0、k_I=0.3（100 Hz）。
  - 权重整定建议：高机动（起降）k₁≪k₂（降低加速度计权重）；电机附近磁干扰大时 k₁≫k₂。
  - e 的叉积结构来自小角度下 SO(3) 测度误差的一阶近似；k_P 决定收敛带宽、k_I 积分消陀螺零偏。
- 结合点: ① 与项目 Mahony 实现（e=a×ĝ 加号约定、Ki 消零偏）逐条对照口径一致；② k₁/k₂ 权重讨论可加进磁交变干扰演示解说（项目「磁误差并入 z 分量」即该思想的固定权重版）；③ 原论文留作课外阅读。

### [B5] Welch & Bishop《An Introduction to the Kalman Filter》(TR 95-041)
- URL: https://www.cs.cmu.edu/~motionplanning/papers/sbp_papers/kalman/welch_intro_kalman.pdf （CMU 镜像，已下载核实；UNC 原链已失效）
- 类型: 讲义（技术报告 16 页）
- 一句话定位: 卡尔曼滤波最经典入门，五公式 + 调参经验。
- 关键内容摘录:
  - 预测：x̂ₖ⁻ = A·x̂ₖ₋₁ (+B·uₖ)；Pₖ⁻ = A·Pₖ₋₁·Aᵀ + Q。更新：Kₖ = Pₖ⁻Hᵀ(HPₖ⁻Hᵀ+R)⁻¹；x̂ₖ = x̂ₖ⁻ + Kₖ(zₖ − Hx̂ₖ⁻)；Pₖ = (I−KₖH)Pₖ⁻。
  - 调参经验（"Filter Parameters and Tuning"节）：**R 一般可离线实测**（静止采样本算方差）；**Q 难以直接观测**，可通过「往过程注入足够不确定度」补偿粗模型；离线调参等价于系统辨识。
  - 定常条件下 Pₖ 与 Kₖ 快速收敛到稳态（增益阵可离线预算）。
- 结合点: ① 项目文档「Q/R 单位换算」可直接引用其「R 实测、Q 注入」原则；② 「K 收敛到稳态」可解释 UI 中卡尔曼增益曲线稳定后的行为。

### [B6] NXP AN4248《Implementing a Tilt-Compensated eCompass》
- URL: https://www.nxp.com/docs/en/application-note/AN4248.pdf （官方；本网络被拦，已从镜像 https://github.com/Lauszus/LaunchPadFlightController/blob/master/docs/CD-ROM/Bibliography/Implementing%20a%20Tilt-Compensated%20eCompass%20using%20Accelerometer%20and%20Magnetometer%20Sensors%20-%20AN4248.pdf 下载核实，Rev 3.0，21 页）
- 类型: 应用笔记
- 一句话定位: 倾斜补偿航向的标准工业公式出处（NED 系）。
- 关键内容摘录:
  - 横滚（eq 13）：tanφ = G_py/G_pz；俯仰（eq 15）：tanθ = (G_px·cosφ + G_py·sinφ)/G_pz。
  - 航向（eq 16-22）：B_f = R_y(θ)R_x(φ)(B_p − V)（先去硬铁偏移 V，再反旋俯仰横滚到水平面），ψ = atan2(B_fy, B_fx)，相对于磁北。
  - 解范围约定：roll/yaw ∈ ±180°，pitch ∈ ±90°；含 ATAN2 的 C# 参考实现（7.4 节）。
- 结合点: ① 项目互补滤波 tiltCompensatedYaw 即 eq 16-22 的实现，可挂此引用；② 「pitch 限 ±90° 保证唯一解」与项目欧拉角显示范围一致；③ 49° 磁倾角、~50μT 场强口径与 NXP 系列笔记一致。

### [B7] NXP AN4246《Calibrating an eCompass in the Presence of Hard- and Soft-Iron Interference》
- URL: https://www.artekit.eu/resources/ak-mag3110/doc/AN4246.pdf （镜像，已下载核实 17 页；官方 https://www.nxp.com/docs/en/application-note/AN4246.pdf ）
- 类型: 应用笔记
- 一句话定位: 硬铁/软铁标定 10 参数模型与拟合流程的标准出处。
- 关键内容摘录:
  - 测量模型（eq 5）：B_p = W·R_x(φ)R_y(θ)R_z(ψ)·B + V，W = W_NonOrthog·W_Gain·W_Soft（eq 4）。
  - 10 参数 = 3 硬铁 V + 6 软铁（对称阵）+ 1 地磁强度 B；标定 = 拟合 10 参数，把测量椭球面变换为原点球面。
  - 简化 4 参数标定（3 硬铁 + 场强）在弱软铁 PCB 上足够。
  - 算例（eq 43）：B = 47.0 μT。
- 结合点: ① 项目「硬铁畸变」模拟与标定三流水线文档可引此为标准流程；② 47μT 算例与项目 ~50μT/49° 磁倾角口径吻合，可做数字对照表。

### [B8] arXiv 1608.07053《Noise modeling and analysis of an IMU-based attitude sensor》（Allan 方差）
- URL: https://arxiv.org/abs/1608.07053 （HTML 版 https://arxiv.org/html/1608.07053v1 ，已核实）
- 类型: 论文
- 一句话定位: 用 Allan 方差分解 MPU-6050 噪声并映射到卡尔曼参数的完整案例。
- 关键内容摘录:
  - Allan 方差定义：σ²(τ) = 1/(2(s−1))·Σᵢ(s_{i+1}(τ)−s_i(τ))²，τ=n·Δt；log-log 图读斜率判型。
  - 系数读法（其表 1）：角度随机游走 **N = σ(1)**（斜率 −1/2）；速率随机游走 **K = σ(√3)**（斜率 +1/2）；零偏不稳定性 **B = σ(min)·√(2ln2/π) ≈ 0.664σ(min)**（平底区）；量化噪声斜率 −1。
  - 结论：该 MPU-6050 噪声 PDF 检验为高斯白，可被实时卡尔曼滤除；长时间数据出现 +1/2 段即漂移零偏。
- 结合点: 直接服务待办「IMU 误差模型升级（Allan 方差级噪声）」：把模拟 IMU 的白噪声/随机游走零偏参数对齐 N/K/B 系数并给出 σ(τ) 曲线图；PSD 与 Allan 互验流程可写进工程实践文档。

### [B9] Andrew Gibiansky《Quadcopter Dynamics, Simulation, and Control》
- URL: https://github.com/Lauszus/LaunchPadFlightController/blob/master/docs/CD-ROM/Bibliography/Quadcopter%20Dynamics%2C%20Simulation%2C%20and%20Control%20-%20Andrew%20Gibiansky.pdf （已下载核实全文；作者原博客 gibiansky.com 本环境 502/404）
- 类型: 博客教程（PDF 存档）
- 一句话定位: 四轴动力学→电机混控→PD 控制的最小闭环教程。
- 关键内容摘录:
  - 电机模型：推力/扭矩 ∝ ω²；总扭矩矩阵含臂长 L 与反扭矩系数 b（4×4 混控矩阵，四方程解四个电机转速）。
  - 控制：τ = I·u，对 roll/pitch/yaw 取 u_i = −(K_d·ω_i + K_p·θ_i)（只有陀螺时用角速度做 D、其积分重构角度做 P）。
  - 悬停补偿：T = mg/cosθ·cosφ；附完整 MATLAB 四轴仿真代码（姿态 + 控制器 + 数值积分）。
- 结合点: 「闭环控制演示」待办的最小模型参考：姿态解算输出 θ 直接进 u_i 公式即可闭环；混控矩阵可演示「姿态解算 + 电机分配」分层。

### [B10] ArduPilot 姿态控制架构与调参文档
- URL: https://ardupilot.org/dev/docs/apmcopter-programming-attitude-control-2.html （已核实）；调参操作页 https://ardupilot.org/copter/docs/ac_rollpitchtuning.html （已核实）
- 类型: 官方文档
- 一句话定位: 串级姿态控制器（角度环→角速率环）的工业实现与调参口诀。
- 关键内容摘录:
  - 架构：外环角度 P 控制器（误差→期望角速率，带 sqrt 整形曲线）→ 内环角速率 PID（陀螺反馈）→ AP_Motors 混控输出；主循环 400 Hz（Pixhawk）。
  - 代码路径：flight mode → `angle_ef_roll_pitch_yaw()` / `rate_bf_roll_pitch_yaw()` 设目标 → `rate_controller_run()` → `AP_Motors::output_armed()`。
  - 调参口诀：P 以 50% 步进加到出现振荡，回退 40%；I 初值取 P；D 以 50% 步进加到振荡后回退；若已振荡先三者减半。
  - 输入标定：遥控 1000 ≈ 10°/10°·s⁻¹。
- 结合点: ① 闭环控制演示可按「角度 P（sqrt 整形）→ 角速率 PID」两层实现，与项目 500 Hz 解算共享陀螺数据；② 调参口诀可做成演示脚本（振荡→回退），教学价值高。

### [B11] CSDN《MPU6050姿态解算——Mahony互补滤波》
- URL: https://blog.csdn.net/lqj11/article/details/107423334 （已核实正文）
- 类型: 博客教程（中文）
- 一句话定位: 中文圈流传最广的 Mahony + 四元数入门推导（MPU6050 实战向）。
- 关键内容摘录:
  - 陀螺积分误差算例：0.1°/s 零偏 → 1 分钟 6°、1 小时 360°。
  - 互补思想：陀螺短期可信/长期漂移；加速度计长期可信/短期受高频振动污染。
  - 由 q̂ 算理论重力 v，与实测重力 g_b 做叉积得误差 e，小角度近似 e≈角度误差，再按 PI 补偿进角速度；**实测参考值 Kp=1.5、Ki=0.005**（MPU6050）。
  - q̇=½q⊗ω 用龙格-库塔/一阶法离散求解。
- 结合点: ① 可作项目文档的中文课外读物（其 e 与 v,g_b 记号帮初学者过渡到项目 e=a×ĝ 约定）；② Kp/Ki 参考值可给调参滑块一个「出厂锚点」；③ 0.1°/s 漂移算例可直接用于零偏漂移演示文案。

### [B12] DR_CAN 卡尔曼滤波系列（B 站视频 + 笔记）
- URL: https://www.bilibili.com/video/BV1jK4y1U78V （【卡尔曼滤波器】6_扩展卡尔曼滤波器，25.7 万播放；已经 B 站 API 核实标题/简介）。系列 1-6 集（状态方程/协方差/卡尔曼增益推导/数据融合/EKF）。配套文字笔记（已核实正文）：https://blog.csdn.net/bear_miao/article/details/125458317
- 类型: 视频 + 中文笔记
- 一句话定位: 中文最好的卡尔曼直观推导视频系列（递归→增益→EKF）。
- 关键内容摘录:
  - 标量直观：K = e_EST/(e_EST+e_MEAS)，K→1 信测量、K→0 信预测（笔记已核实）。
  - 推导链：状态空间 x_k = A·x_{k-1}+B·u+w → 先验/后验协方差 → 卡尔曼增益 30 分钟详细推导 → EKF 局部线性化（第 6 集）。
  - 特点：白板手推、不跳步，协方差与增益的「为什么」讲透。
- 结合点: ① 文档「零基础向数学工具箱」可引用该系列作视频补充；② EKF 集的「局部线性化」正对应项目 ES-EKF 在名义态处线性化的叙事；③ 视频正文未逐帧核实，公式以 CSDN 笔记交叉确认。

### [B13] DCM 理论与漂移修正（Premerlani & Bizard 的可达替代）
- URL: 原论文《Direction Cosine Matrix IMU: Theory》(2009) 现仅 ResearchGate/Scribd 有全文（本环境不可达，**未直接验证**）。已验证替代：① TU/e 论文《Direction cosine matrix based IMU implementation in Matlab》https://pure.tue.nl/ws/files/3828390/900712107626514.pdf （完整复刻 DCM 更新+漂移修正，已下载核实）；② Starlino DCM 教程中文翻译 https://www.cnblogs.com/andychenforever/p/6298073.html （已核实正文）
- 类型: 论文 + 中文翻译教程
- 一句话定位: DCM（方向余弦阵）姿态滤波的漂移修正与重正交化经典思路。
- 关键内容摘录（TU/e 版，编号对应原算法）:
  - DCM 传播（eq 2.3）：R(t+Δt) = R(t)·(I + [r_rot]×Δt)，r_rot = ω_P + ω_P,yaw + ω_I（陀螺 + P 比例漂移修正 + I 积分漂移修正）。
  - 重正交化（eq 2.4-2.6）：e = r_x·r_y（两行点积为正交性误差），r_x′ = r_x − e/2·r_y，r_y′ 同理；第三行 = 叉积；再精确归一化。
  - 漂移修正来源：横滚/俯仰用加速度计、偏航用磁力计；无新磁数据时 P_yaw 项按 97% 衰减防旧误差累积。
  - 中文翻译版给出三源加权融合 dθ = (s_a·dθ_a + s_g·dθ_g + s_m·dθ_m)/(s_a+s_g+s_m)。
- 结合点: ① DCM 的 P/I 漂移修正与项目 Mahony 的 k_P/k_I 在连续极限下等价，是「叉积误差三性质」章节的姊妹视角；② 重正交化的 e/2 修正可对照项目四元数归一化（q/‖q‖ 与 DCM 一阶修正的精度差异）；③ 无新磁数据时的 P 衰减技巧可借鉴到磁交变干扰处理。

---

## 4. 开源实现与官方文档（C 线，10 条）

### [C1] x-io Technologies — 开源 IMU/AHRS 算法官方主页（Madgwick 原始发布页）
- URL: https://x-io.co.uk/open-source-imu-and-ahrs-algorithms/
- 类型: 官方文档
- 一句话定位: Sebastian Madgwick 2009 年算法的官方发布页，C/C#/MATLAB 三种实现的原始下载入口。
- 关键内容摘录:
  - 提供 C、C#、MATLAB 三套原始代码，另附 Madgwick 版 Mayhony DCM 滤波四元数实现与 LabVIEW 社区移植。
  - 页面明确声明算法「现已更名 Fusion，托管于 GitHub（xioTechnologies/Fusion）」——老版 Madgwick 代码已停止维护。
  - 文档资源：原始内部报告 PDF 与 IEEE 会议论文链接；另有 IMU/AHRS/相机增稳三个 YouTube 演示视频（2009 原版）。
- 结合点: 项目 Mahony/Madgwick 文档章节的「出处引用」权威页；「教学用原始代码 vs 工业现役 Fusion」的演进关系可写进滤波选型表备注。

### [C2] Madgwick 原始 C 源码（镜像）与 Arduino 官方移植
- URL: https://github.com/kdienes/madgwick-ahrs/blob/master/MadgwickAHRS/MadgwickAHRS.c （Arduino 官方移植：https://github.com/arduino-libraries/MadgwickAHRS/blob/master/src/MadgwickAHRS.cpp ）
- 类型: 代码文件
- 一句话定位: 原始 MadgwickAHRS.c 源码，可直接对照梯度下降修正项与默认增益。
- 关键内容摘录:
  - `#define betaDef 0.1f // 2 * proportional gain`——**默认 β=0.1**，注释含义为「2 倍比例增益」；`volatile float beta` 运行期可改。
  - `#define sampleFreq 512.0f`——固定采样频率宏（老代码假设定频，项目用变步长 dt）。
  - 双接口：`MadgwickAHRSupdate(gx…mz)` 与无磁力计的 `MadgwickAHRSupdateIMU(gx…az)`；**磁力计读数全零时 AHRS 版自动退化为 IMU 版**。
  - 流程：陀螺四元数变化率 qDot → 归一化 accel/mag → 梯度下降步 s0–s3 → 归一化步长 → `qDot - beta*s` 反馈 → 积分 → 归一化。
  - `invSqrt` 为 Quake 快速逆平方根（0x5f3759df）；自带欧拉角转换，pitch 用 `copysign(π/2, sinp)` 钳制。
- 结合点: 项目 Madgwick β 滑块默认值可标注「原始代码 β=0.1（≈2×陀螺误差 rad/s）」作对照；「磁力计全零自动降级」可在干扰场景演示中提示（与项目「磁参数全零时不消耗 gauss.next()」的守护思路呼应）。

### [C3] xioTechnologies/Fusion — 现代 AHRS C 库（文档极佳）
- URL: https://github.com/xioTechnologies/Fusion
- 类型: 开源库
- 一句话定位: Madgwick 本人维护的现役 AHRS 库（MIT，C + Python `imufusion`），以恢复机制和增益调度著称。
- 关键内容摘录:
  - 算法基于 Madgwick 博士论文**第 7 章**修订版 AHRS（非最有名的第 3 章），本质为互补滤波：陀螺积分 + accel/mag 误差反馈项。
  - **启动初始化：增益从 10 起在 3 秒内线性下降到设定值**，期间关闭加速度/磁拒绝——允许任意初始姿态快速收敛。
  - **恢复机制**：角速率超过量程 98% 触发整体重启；加速度拒绝阈值 **10°**（倾角与输出不一致则丢弃加速度计）；持续加速度超过 5 秒超时窗内 90% 时间越限则进入加速度恢复；磁拒绝/恢复同构（作用于磁航向）。
  - 推荐增益 **0.5**（0 表示纯陀螺）；偏置估计器默认 100 Hz、静止阈值 **3°/s**、静止时长 **3 s**，偏置可存 NVM。
  - API：`FusionAhrsSetSettings/GetInternalStates/GetFlags`；`FusionQuaternionToMatrix/Euler`；`FusionRemap` 支持 24 种正交轴重排，官方支持 NWU/ENU/NED 约定。
- 结合点: ① 40° 新息门控（ES-EKF）可对照 Fusion 的 10° 拒绝阈值——「测量门控」教学素材，幅度差 4 倍值得讨论；② 启动增益 ramp 是互补/Mahony 估计器最值得吸收的改进（演示「初始对准收敛」）；③ `GetInternalStates/GetFlags` 与项目 telemetry 接口设计同构；④ 3°/s 静止阈值可移植为模拟 IMU 的静止检测演示。

### [C4] PX4 官方文档 — 使用导航滤波器（EKF2/ECL）
- URL: https://docs.px4.io/main/en/advanced_config/tuning_the_ecl_ekf
- 类型: 官方文档
- 一句话定位: PX4 主力 24 状态 EKF 的官方使用/调参文档，含磁航向融合模式与初始化条件。
- 关键内容摘录:
  - 状态：NED→机体系四元数、NED 速度/位置、陀螺与加速度计零偏、地磁场（NED 3 维）与机体系磁场偏置（3 维）、风速（2 维）+ 地形高度；采用误差状态公式保证稳定，协方差更新用 Joseph 形式。
  - `EKF2_MAG_TYPE` 融合模式：Automatic（解锁前仅修航向，解锁后全姿态）、Magnetic heading（只修航向不动倾斜）、None、Init only——**磁力计对倾斜与航向的影响被显式分级**。
  - 初始化门槛：需 ≥100 Hz 角增量/角速度数据 + 偏航源（磁力计或外部视觉）+ ≥5 Hz 高度源。
  - 无磁力计时可用多假设滤波器（GSF）从 GPS 速度估计偏航；GNSS 质量门控：eph<3 m、epv<5 m、卫星≥6、sacc<0.5 m/s、PDOP<2.5 等。
- 结合点: ① 互补滤波「倾斜补偿航向」与 PX4 Magnetic-heading 模式一致，可引作工业佐证；② 磁干扰场景可对照 EKF2_MAG_TYPE=Init only/None 的降级策略。

### [C5] ArduPilot 官方文档 — EKF2 估计系统（24 状态详解）
- URL: https://ardupilot.org/dev/docs/ekf2-estimation-system.html
- 类型: 官方文档
- 一句话定位: ArduPilot EKF2 的状态向量与误差状态公式的最清晰官方表述。
- 关键内容摘录:
  - 24 状态分组表：姿态四元数(4)+NED 速度(3)+位置(3)+陀螺零偏(3)+陀螺比例因子(3)+Z 轴加计零偏(1)+地磁场(3)+机体系磁场(3)+风速(2)。
  - 核心思想：**不直接估计四元数，而是估计误差旋转矢量再修正四元数**（引 Pittelkau 2003）——与项目 ESKF 的 [δθ,δb] 完全同源。
  - 量测与状态/协方差取同一时刻（延迟时间窗），用互补滤波式输出预测器外推到当前（Khosravian 2015）。
  - 启动时「运动中同时估计陀螺零偏与姿态」；GPS 需连续 10 s 通过检查才设原点。
- 结合点: ① ESKF 文档章节可直接引用此页作为「误差旋转矢量参数化」的工程出处；② 6 维 [δθ,δb] 扩展到 24 维的教学路线图（下一步可加陀螺比例因子/磁场状态）。

### [C6] MathWorks Sensor Fusion Toolbox — imufilter 官方文档
- URL: https://www.mathworks.com/help/fusion/ref/imufilter-system-object.html
- 类型: 官方文档
- 一句话定位: 六轴间接卡尔曼滤波的教科书级官方文档，状态定义与默认噪声矩阵可直接引用。
- 关键内容摘录:
  - 间接 KF，9 元误差状态：[θ(3, rad); b(3, 陀螺零偏 rad/s); a(3, 机体系线加速度误差 g)]——比项目 ESKF 多一个线加速度状态。
  - InitialProcessNoise 默认 9×9 对角阵：前三块 0.000006092348396，中间三块 0.000076154354947，末三块 0.009623610000000（顺序 θ/b/a）。
  - 针对「真实 IMU」的经验调参值：GyroscopeNoise=7.6154e-7、AccelerometerNoise=0.0015398、GyroscopeDriftNoise=3.0462e-12、LinearAccelerationNoise=0.00096236，并把 InitialProcessNoise×10。
  - 线加速度建模为低通白噪声（DecayFactor∈[0,1)）；因误差过程先验恒为零，标准 KF 简化（F=0）。
  - 接口：`[orientation,angularVelocity,residualData] = fuse(accel,gyro)`；**算法假设首帧前设备静止**，初始姿态由 ecompass 给出（假设 x 轴指北）；NED 下重力分量为正、ENU 为负。R2024a 起第三输出 residualData 给残差与残差协方差；配套 `tune` 函数按真值自动调参。
- 结合点: ① ESKF 的 Q/R 滑块可对照此默认数值表讲「为什么卡尔曼参数长这样」；② 「首帧静止 + ecompass 初始对准」可补进工程实践文档初始对准节；③ 线加速度入状态正对项目线加速度扰动源，可作 ESKF 扩展演示。

### [C7] three.js 官方文档 — Quaternion 与 Euler
- URL: https://threejs.org/docs/#api/en/math/Quaternion （Euler: https://threejs.org/docs/#api/en/math/Euler ）
- 类型: 官方文档
- 一句话定位: 项目 quatview/3D 视图所有四元数 API 的权威语义来源。
- 关键内容摘录:
  - 文档明确 **"three.js expects Quaternions to be normalized"**；构造默认 (0,0,0,1)；迭代与 `toJSON()` 输出顺序均为 **(x,y,z,w)**。
  - `slerp(qb,t)`：t∈[0,1] 插值，**超出区间为外插**；`slerpQuaternions(qa,qb,t)` 不修改输入；另有扁平数组静态版 `slerpFlat`。
  - `rotateTowards(q, step)`：按**弧度**步进向目标旋转，「保证不会过冲」。
  - `premultiply(q)` = this ← q·this（左乘）；`multiply(q)` = this ← this·q（右乘）。
  - `invert()` **假设单位长度**（内部走 conjugate）；`angleTo(q)` 返回弧度夹角；`setFromEuler(euler)` 遵循 euler.order，**Euler 默认 order='XYZ'**、单位弧度；`setFromUnitVectors(vFrom,vTo)` 要求两向量已归一化。
- 结合点: quatview 展示估计四元数前应 normalize；遥测数值序列注意 (x,y,z,w) 顺序；premultiply/multiply 的系别语义（世界系/机体系）文档未展开，需在项目文档中显式说明，避免误差四元数增量方向画反；`angleTo` 可作「估计 vs 真值角度误差」的官方实现依据。

### [C8] three.js 官方示例 — webgl_math_orientation_transform
- URL: https://threejs.org/examples/#webgl_math_orientation_transform （源码 https://github.com/mrdoob/three.js/blob/dev/examples/webgl_math_orientation_transform.html ）
- 类型: 官方示例
- 一句话定位: 官方演示「物体平滑转向目标姿态」的推荐写法（quaternion 伺服）。
- 关键内容摘录:
  - 核心循环：`if (mesh.quaternion.equals(targetQuaternion) === false)` 未收敛才更新；`mesh.quaternion.rotateTowards(targetQuaternion, step)`，step = 速度×dt。
  - 目标姿态由 `targetQuaternion.setFromRotationMatrix(rotationMatrix)` 生成；全例仅用 Quaternion API 组合：equals（收敛判定）+ rotateTowards（渐近转向），无欧拉角参与。
- 结合点: 四元数弧线视图「估计姿态追踪真值姿态」的动画可直接套用（equals + rotateTowards）；官方背书「姿态动画不用欧拉角插值」，可作文档页最佳实践引用。

### [C9] Adafruit 教程 — MotionCal 磁力计标定实操
- URL: https://learn.adafruit.com/how-to-fuse-motion-sensor-data-into-ahrs-orientation-euler-quaternions/magnetic-calibration-with-motioncal （工具仓库：https://github.com/PaulStoffregen/MotionCal ）
- 类型: 官方文档 + 开源工具
- 一句话定位: PJRC MotionCal 图形化标定工具的标准工作流，椭圆/球面拟合思想的最佳入门表述。
- 关键内容摘录:
  - 工作流：烧录标定固件流式输出 accel/gyro/mag → MotionCal 连接串口 → **转动传感器直至红色点云铺满完整球面**（覆盖度反馈）→ "Send Cal" 按钮激活后写入。
  - 输出三组数：Hard iron offsets（示例 [-31.25, 35.67, -116.44]）、Soft iron offsets（3×3 矩阵）、Field strength（uT）。
  - 工具价值点：3D 点云可视化、离群点剔除、「球面覆盖度」进度反馈；即椭圆拟合到单位球的思想（硬铁平移 + 软铁线性变换）。
- 结合点: 项目磁力计硬铁/软铁干扰模拟 ↔ 标定流程可做成「采集点云→拟合→补偿」演示页；Field strength 可对照项目磁倾角参数。

### [C10] Adafruit_AHRS — 统一接口的多算法 Arduino 库
- URL: https://github.com/adafruit/Adafruit_AHRS （接口文件 src/Adafruit_AHRS_FusionInterface.h）
- 类型: 开源库
- 一句话定位: 与项目「统一估计器接口」几乎同构的工业参考：一个抽象接口下跑 Mahony/Madgwick/NXP。
- 关键内容摘录:
  - 抽象接口 `Adafruit_AHRS_FusionInterface`：`begin(float sampleFrequency)` + `update(gx,gy,gz,ax,ay,az,mx,my,mz)`，**单位约定：陀螺 dps、加速度计 g、磁力计 uT**。
  - 输出端：`getRoll/Pitch/Yaw`、`getQuaternion(w,x,y,z)`、`setQuaternion(w,x,y,z)`（可直接注入初始姿态）、`getGravityVector(x,y,z)`。
  - 三实现按资源分级：Mahony（最低内存/算力）、Madgwick（中等）、NXP Fusion 卡尔曼（最重）。
  - Mahony 类暴露 `twoKp/twoKi`（注释「2×比例增益/2×积分增益」）+ `integralFBx/y/z` 积分反馈项与 `updateIMU` 无磁版本。
- 结合点: ① 项目 `update(gyro,accel,mag,dt)` 接口 vs Adafruit「定频 begin + 无 dt」两种设计可写进文档接口设计对比；② setQuaternion 支持姿态注入——「初始姿态错误」演示可引用此设计；③ **twoKp=2×Kp 约定与 Madgwick betaDef 注释一致，讲滑块数值时注意 ×2 关系**。

---

## 5. 交互教学设计与传感器工程实践（D 线，12 条）

### [D1] Bartosz Ciechanowski — Tesseract（四维超立方体交互长文）
- URL: https://ciechanow.ski/tesseract/
- 类型: 交互科普
- 一句话定位: 用「同一交互逐维重复」的手法把 4D 几何讲成可上手实验，与项目 4D 立体投影模式直接同构。
- 关键内容摘录:
  - 核心手法：每个维度用**同一个滑杆**「把形状拉进新的一维」（点→线段→正方形→立方体→超立方体），交互模式重复，规律向上迁移。
  - 「歧义表示」一节：分段控件切换黑点在 3 个不同 4D 位置，肉眼看起来完全一样——用交互让「低维投影有歧义」直观化，再引入辅助线消歧。
  - 「影子」一节：左面板可拖拽旋转立方体，右面板同步显示 xy 平面直视图；「投影假象」与「真实几何」分两个面板对照。
  - 旋转教学：不按轴、而按**平面**讲 4D 旋转（xw/yw/zw 六个基本平面），一个滑杆控制单一平面旋转。
  - 结尾「切片」演示：四个滑杆自由组合，切片呈现长方体或凸多面体。
  - UI 细节：半透明着色墙体区分重叠投影分量；正文内嵌锚点链接可直接跳到仿真的特定状态。
- 结合点: 文档页「四元数与 4D 投影」章节可模仿「左真实 4D / 右 3D 投影」双面板布局；内嵌锚点直达仿真状态的做法可用于每个 Canvas 演示的「示例状态一键还原」；「同一交互逐维重复」可用于标量→向量→四元数的渐进推导结构。

### [D2] Bartosz Ciechanowski — GPS（渐进式估计叙事）
- URL: https://ciechanow.ski/gps/
- 类型: 交互科普
- 一句话定位: 每一节固定上一节玩具模型的缺陷再升级，把时钟偏差/误差/最优估计讲成可拖拽实验——「ES-EKF 为什么存在」的最好叙事范本。
- 关键内容摘录:
  - 叙事骨架：每节开头先让读者看到当前模型的失败，再补一块新机制（BUT/THEREFORE 式推进）。
  - **时钟偏差滑杆**：读者拖动接收机钟差，看到伪距球面整体错位；第 4 个卫星的必要性由此演示。
  - 误差全部「可视化而不代数化」：不确定度画成厚球壳，卫星几何不好时球壳相交模糊；「best fit that minimizes the error」一句话带过最小二乘。
  - 相对论钟差 ~38 μs/天；澄清「不修正每天差 11.6 km」的网络讹传。
  - 正文明确说「数学运算对理解 GPS 不是关键」，公式只留核心，代数全部延后。
- 结合点: ① 「滤波算法讲解」章节结构：先让纯积分在零偏+噪声下滑漂，再引出互补/Mahony/EKF，每节「先失败、后补救」；② 「零偏滑杆 + 伪观测球壳」类比演示陀螺零偏如何让姿态错位；③ 误差画厚壳而非报数字的做法可用于姿态误差锥可视化。

### [D3] Nicky Case — How I Make Explorable Explanations（可探索解释方法论）
- URL: https://blog.ncase.me/how-i-make-an-explorable-explanation/
- 类型: 交互科普（方法论）
- 一句话定位: 可探索解释的四段式方法论：钩子问题 → 抽象阶梯 → BUT/THEREFORE 结构 → 开放式沙盒结尾。
- 关键内容摘录:
  - **Hook**：开篇必须让读者「爱上你的问题」，问题可藏在故事或游戏里。
  - **抽象阶梯**（师承 Bret Victor）：从具体体验一步步爬向抽象，爬高后要再降回具体。
  - **BUT/THEREFORE**：段落间用转折与因果串联，不用「然后」；《The Evolution of Trust》几乎每一拍都是反直觉反转。
  - **结尾 = Sandbox Mode**：《Parable of the Polygons》《Trust》都以自由沙盒收尾——「开头给读者我的问题，结尾让读者探索自己的问题」。
- 结合点: ① 每章开头加量化钩子（「为什么无人机悬停 1 分钟后航向自己歪了 15°？」）再进入推导；② 三段式滑杆文案可按「抽象阶梯」重排：先拖滑杆看现象，再给术语，最后给公式；③ 文档页末尾设「沙盒模式」（解锁全部滑杆 + 自由扰动组合）；④ 章节间用「积分漂了→所以要加速度计→但振动又骗它→所以要融合」的 BUT/THEREFORE 链改写目录逻辑。

### [D4] Explorable Explanations 社区主页（explorabl.es）
- URL: https://explorableexplanations.github.io/ （301 跳转至 https://explorabl.es/ ）
- 类型: 交互科普（社区索引）
- 一句话定位: 「learning through play」运动的社区枢纽，按学科索引全球交互式科普作品。
- 关键内容摘录:
  - 自我定位：「艺术家、程序员与教育者组成的松散运动」，主张游戏与学习不应分离。
  - 页面结构：随机轮换展示 3 部作品、按学科浏览、教学制作工具、「ALL OF IT」单页全列；站点开源。
- 结合点: 文档页「延伸阅读」栏目的素材池（按 Physics/Math 学科筛选）；「随机展示 3 部作品」的入口设计可用于首页演示位轮换。

### [D5] TDK InvenSense ICM-42688-P 产品页规格（6 轴 IMU 现役主力）
- URL: https://www.invensense.tdk.com/products/motion-tracking/6-axis/icm-42688-p/ （数据手册 DS-000347 v1.6 PDF：https://product.tdk.com/system/files/dam/doc/product/sensor/motion-inertial/imu/data_sheet/ds-000347-icm-42688-p-v1.6.pdf ，TDK 服务器 403，规格以官方产品页核实为准）
- 类型: 官方文档 / 数据手册
- 一句话定位: 教学用「现代 MEMS IMU 标杆」规格来源，参数量级远优于 MPU-9250 一代。
- 关键内容摘录:
  - 陀螺量程 8 档可编程：±15.625/31.25/62.5/125/250/500/1000/2000 dps；加速度计 ±2/4/8/16 g。
  - **陀螺噪声谱密度 2.8 mdps/√Hz；加速度计噪声谱密度 70 μg/√Hz**（典型值）。
  - 低噪声模式 6 轴电流 0.88 mA；封装 2.5×3×0.91 mm；接口 I3C/SPI 24 MHz。
  - 片上 APEX 功能：计步、倾斜检测、敲击检测、Wake on Motion；陀螺/加速度计用户可编程数字滤波器。
- 结合点: 模拟 IMU 参数面板加「器件预设」下拉（选 ICM-42688-P 写入量程/噪声密度真实值）；噪声密度数量级对比教学（2.8 vs 10 mdps/√Hz）演示「换一颗传感器漂移差几倍」。

### [D6] InvenSense MPU-9250 产品规格书 PS-MPU-9250A-01 v1.1（9 轴，教学最常用）
- URL: https://download.mikroe.com/documents/datasheets/PS-MPU-9250A-01-v1.1.pdf （镜像 PDF，全文已抓取）
- 类型: 数据手册
- 一句话定位: 9 轴 MEMS IMU 的教科书级规格书，三传感器噪声/零偏/交叉轴敏感度数值齐全，是模拟 IMU 参数默认值的最佳出处。
- 关键内容摘录:
  - 陀螺：量程 ±250/500/1000/2000 dps，16 位 ADC，灵敏度 131/65.5/32.8/16.4 LSB/(°/s)，容差 ±3%；**噪声密度 0.01 dps/√Hz**；总 RMS 噪声 0.1 °/s-rms（DLPF 92 Hz）；**初始零偏容差 ±5°/s**。
  - 加速度计：±2/4/8/16 g；零 g 初始容差 X/Y ±60 mg、Z ±80 mg；**噪声密度 300–400 μg/√Hz**；总 RMS 噪声 8 mg-rms；非线性 ±0.5%；**交叉轴敏感度 ±2%**；灵敏度温漂 ±0.026 %/°C。
  - 磁力计（AK8963）：13 位输出，**分辨率 0.6 μT/LSB，满量程 ±4800 μT**；内部采样 8 Hz（连续模式）。
  - 电流：陀螺 3.2 mA @8 kHz、加计 450 μA、磁力计 280 μA@8 Hz；ODR：陀螺 4–8000 Hz、加计 4–4000 Hz；DLPF 可配置。
- 结合点: ① 模拟 IMU 默认参数直接取自此表（陀螺零偏 ±5 dps 量级、噪声密度换算成仿真步长方差）；② 「交叉轴敏感度 ±2%」「非线性 ±0.5%」是项目尚未模拟的误差项，可作进阶滑块；③ 磁力计 0.6 μT/LSB 分辨率补充「量化误差」与「饱和」概念；④ 工程实践章节可加「读懂数据手册」小节，以此表为范例。

### [D7] Bosch BNO055 数据手册（片上融合「智能传感器」）
- URL: https://www.bosch-sensortec.com/media/boschsensortec/downloads/datasheets/bst-bno055-ds000.pdf （PDF 已全文抓取核实）
- 类型: 数据手册
- 一句话定位: 「传感器自带解算」的代表作——三传感器 + Cortex-M0 片上融合直接输出四元数，是本项目 5 种自研算法的天然对照组。
- 关键内容摘录:
  - SiP 架构：14 位加速度计（±2–16 g）+ 16 位陀螺（±125–2000 °/s）+ 13 位磁力计（130–2500 μT），片内 ARM Cortex-M0 跑融合固件。
  - 直接输出四元数（单位四元数 Q0-Q3，标量在前）、欧拉角、旋转矢量、线性加速度、重力矢量等。
  - **融合模式枚举：NDOF / NDOF_FMC_OFF / IMUPLUS / COMPASS / M4G / GYROREST / ACCELONLY**——不同模式用不同传感器子集。
  - 陀螺零偏自动校准（每轴 ±0.09°/s 分辨率）；磁力计自动校准用磁强计量级+扰动检测。
  - 陀螺典型噪声 0.014 dps/√Hz、RMS 噪声 0.10° rms；零偏温漂 0.001 °/s/°C；加计零偏温漂 ±0.15 mg/°C、噪声 175 μg/√Hz。
- 结合点: ① 文档页新增「片上融合 vs 软件融合」对比小节（BNO055 相当于把项目 Mahony/EKF 固化进传感器，讨论黑盒/可控性/成本取舍）；② 融合模式枚举表 → 「模式选择器」演示（只开加计/只开陀螺/全融合），复用现有 5 算法框架；③ 自动校准机制呼应磁交变干扰模拟：演示「片上校准也会被欺骗」。

### [D8] ST AN4509《用低 g 三轴加速度计做倾角测量》
- URL: https://www.st.com/resource/en/application_note/an4509-tilt-measurement-using-a-lowg-3axis-accelerometer-stmicroelectronics.pdf （PDF 已全文抓取核实）
- 类型: 应用笔记
- 一句话定位: 厂商应用笔记里最适合教学的一篇：从单轴正弦关系讲到三轴 atan2，附灵敏度逐角度数值表与误差源分析。
- 关键内容摘录:
  - 单轴模型 A = g·sin(α)；**灵敏度表逐角度给出：0° 附近 17.45 mg/°，±90° 附近仅 0.15 mg/°**——「越竖直越测不准」的定量表述。
  - 正弦线性度好的区间：[0°,45°]、[135°,225°]、[315°,360°]。
  - 双轴方案的坑：30° 与 150° 解相同（反正切歧义），须按正交轴是否接近 ±1 g 决定用哪个公式。
  - 三轴公式：α = atan2(Ax, √(Ay²+Az²))，β = atan2(Ay, √(Ax²+Az²))，γ = atan2(√(Ax²+Ay²), Az)——360° 内灵敏度恒定。
  - 误差源逐项讨论：零 g 偏移、灵敏度失配、交叉轴敏感度；先校准（min-max 类）再代入公式。
- 结合点: ① 「加速度计」章节补「单轴→双轴→三轴」演进讲解，配现有 SVG 风格画灵敏度曲线（17.45→0.15 mg/°）；② 线加速度扰动滑块可联动演示「线加速度污染后倾角公式失效」；③ min-max 校准法可做成 Canvas 交互（拖动 6 面放置采样点）。

### [D9] VectorNav 惯性导航入门教程（Inertial Navigation Primer）
- URL: https://www.vectornav.com/resources/inertial-navigation-primer （章节页示例：…/math-fundamentals/math-attituderep ，正文已核实；WebFetch 直连会跳回首页，需用网页阅读器）
- 类型: 官方文档 / 厂商白皮书
- 一句话定位: 厂商系统化入门教程的标杆：姿态表示 → 传感器 → 机动对准逐章推进，工业级表述可对齐项目「工程实践」章节。
- 关键内容摘录:
  - 姿态表示：DCM、欧拉角、四元数并排给出；欧拉角「旋转次序不可交换」、大角度奇点；四元数 4 参数无奇点。
  - 全部姿态表示须先定义参考系（惯性系/载体系/NED 导航系），**坐标系约定单独成节**——初学者最常踩的坑被前置。
  - 传感器章节：陀螺测角速度、加计测**比力（specific force，含重力项）**、磁力计测地磁矢量；噪声用高斯白噪声 + 随机游走表述。
  - 姿态对准：初始对准分粗对准（加计测重力、磁计测航向）与精对准（卡尔曼收敛）；「陀螺不可观测静止航向」。
- 结合点: ① 文档「零基础数学推导」对照其章节骨架自查缺口：坐标系约定、比力与重力的区别建议补齐；② 「比力 ≠ 加速度」正是线加速度扰动的理论根；③ 「先坐标系后公式」的写法可直接抄到中文文档页。

### [D10] O. J. Woodman《An Introduction to Inertial Navigation》剑桥技术报告 UCAM-CL-TR-696
- URL: https://www.cl.cam.ac.uk/techreports/UCAM-CL-TR-696.pdf （PDF 已全文抓取核实）
- 类型: 学术入门报告（37 页免费）
- 一句话定位: 用「惯性导航 1 秒会漂多少」的具体数字把噪声/零偏/随机游走讲透，数值可直接搬进教学。
- 关键内容摘录:
  - 核心教学法：三个 1 秒平移例子——加计白噪声 0.0004 m/s²/√Hz → 位移误差 σ=0.0002 m；加计零偏 0.002 m/s² → σ=0.001 m；陀螺角随机游走 0.0002 rad/√Hz → σ=0.001 m。结论：**积分加速度计得位移只能撑秒级，长时间必须外部辅助**。
  - 误差分析链条：白噪声积分成随机游走 → 零偏积分成平方增长误差；Allan 方差作为区分各误差项的实验工具。
  - 姿态确定：「只用加速度计 = 重力矢量投影测倾角」「只用陀螺 = 角速度积分会漂」的互补性论断——互补滤波的理论出处级表述。
  - 全文公式为大学低年级数学，无需付费库即可复现。
- 结合点: ① 「工程实践」章节直接引入其 1 秒误差数字作为「为什么需要滤波」的量化开场；② 补「白噪声→随机游走→零偏平方增长」三级误差演化 SVG 图（现有 Canvas 漂移演示可叠加三种误差分解）；③ 互补性论断用于互补滤波章节引文级支撑。

### [D11] ArduPilot 官方用户文档 — 加速度计校准（6 面校准）
- URL: https://ardupilot.org/copter/docs/common-accelerometer-calibration.html
- 类型: 官方文档（飞控用户文档）
- 一句话定位: 真实飞控把「6 面静置采样」写成用户引导话术的范本，强调「静止比精确更重要」。
- 关键内容摘录:
  - 六步流程：Level → Right → Left → Nose down → Nose up → On its back，每步摆好姿态按键确认。
  - 引导金句："The vehicle must be kept still immediately after pressing the key for each step"；各非水平姿态允许「差 20 度以内」，但**禁止手扶**（放地上或夹具）。
  - "The level position is the most important to get right as this will be the attitude that your controller considers level while flying"——水平位决定飞控的「水平」认知。
  - 校准内容：三轴偏移 + 全量程刻度；装机后可再跑 Calibrate Level 修正安装误差，**只能纠 ±10° 且只纠横滚/俯仰**。
  - 顺序约定：加速度计校准 → 罗盘校准；有 IMU 恒温炉建议再做温度校准。
- 结合点: ① 工程实践章节新增「真实飞控怎么校准」小节：6 面校准做成 Canvas 交互（点选 6 姿态、看偏移/刻度因子逐面收敛）；② 「静止比精确重要」「水平位最重要」两条话术可直接做成教学要点卡片。

### [D12] ArduPilot 官方用户文档 — 罗盘校准（球面拟合舞蹈）
- URL: https://ardupilot.org/copter/docs/common-compass-calibration-in-mission-planner.html
- 类型: 官方文档（飞控用户文档）
- 一句话定位: 把磁力计椭球拟合校准写成「举机转六面 + 绿色进度条」的交互式用户引导，含失败排查决策树。
- 关键内容摘录:
  - 前置条件话术：良好 3D GPS 锁（必要时到室外）；远离金属与磁源（computers, cell phones, metal desks, power supplies）；口袋掏空电子产品。
  - 「舞蹈」流程：空中轮流让六个面各朝下数秒；**界面绿色进度条随姿态覆盖度向右伸长（球面填充隐喻）**。
  - 成功/失败反馈：成功 = 三声上行音 + 重启提示；失败 = 「unhappy」音 + 进度条重置自动重试。
  - 排障决策树：换磁更干净的位置 → 放宽 Fitness → 把 COMPASS_OFFS_MAX 从 850 提到 2000–3000 → 禁用最差的罗盘。
  - 板载校准自动解算 offsets + scaling + orientation；世界磁场模型内置，换场地无需重校，磁倾角在起飞前自检。
- 结合点: ① 磁力计章节做「校准舞蹈」交互：拖拽虚拟机体系绕六方向旋转，椭圆/球面点云逐步收圆——对应硬铁偏移的椭圆畸变可视化；② **绿色进度条 = 姿态覆盖度**：磁力计模拟可加「覆盖度环」反馈控件；③ 排障决策树（尝试顺序 + 参数名 + 数值范围）是「工程实践」章节的最佳行文模板。

---

## 6. 综合改进建议（从资料提炼，按优先级）

> 编号引用上文条目（A/B/C/D）。所有建议均已对照项目现状（五估计器、四元数视图、文档页四大模块）筛选过，与已有功能重复的未列入。

**基线结论（B 线逐条对照）**：项目已实现公式与文献口径一致（Mahony e=a×ĝ 加号约定、Ki 消零偏；互补滤波倾斜补偿航向 = AN4248 eq16-22；ES-EKF 乘性误差状态有 Markley 背书；NED/49°/50μT 与工业口径吻合）。以下建议以「深化、补直觉、补工程」为主，不涉及纠错。

### P1 · 小改动大收益（文案/标注/小演示）

1. **双倍覆盖的具象体验**（A1/A5）：4D 投影模式加「累计旋转角」读数——3D 姿态转 360° 复原时 S³ 轨迹只到对径点（q 变 −q），转 720° 才回起点。讲解词用 A1「纬度=半角、南北极同为恒等」与 A5「每一对对径点表示同一旋转」。
2. **万向节锁「矩阵证据」折叠块**（A9）：复刻 Brett 讲义的数值实验——pitch=±90° 时 roll±δ 与 yaw∓δ 给出同一旋转矩阵（JS 十行以内），放在平衡环架演示旁；与现有演示构成「代数现象 + 机械直观」双证据。
3. **非交换性预置场景**（A1）：加「先 yaw 后 pitch vs 先 pitch 后 yaw」双幻影对比场景，现有真机+幻影架构直接支持。
4. **估计器参数标注物理含义**（B1/C2/B11/C10）：
   - Madgwick β：标注 β = √(3/4)·ζ̄（ζ̄=陀螺误差模长，rad/s）；原始代码默认 β=0.1 且注释「2×比例增益」；运算量 IMU 109 / MARG 277 次标量运算（500 Hz 下有直观意义）。
   - Mahony：给参考锚点 Kp≈1.5、Ki≈0.005（MPU6050 实战值）；补 k₁/k₂ 传感器权重讨论（高机动降低加计权重、磁干扰大时降低磁权重——正好对应项目的线加速度与磁干扰源）。
   - 注意工业库 twoKp/twoKi = 2×Kp/Ki 的约定差（C10）。
5. **启动增益 ramp + 三段式初始对准**（C3/C6/D9）：互补/Mahony 增益从 10 线性降至设定值（3 s，期间关闭拒绝）实现任意初始姿态快速收敛；配套「静止检测（3°/s、3 s）→ 加计重力对准 → 磁计航向对准」演示——同时补齐工程实践文档「初始对准」节（imufilter 首帧静止 + ecompass 假设、PX4 对准门槛、VectorNav 粗/精对准）。
6. **文档口径补强**（A1/A3）：
   - 加 Hamilton vs JPL/Shuster 约定对照框（Eigen/ROS/SciPy 用 Hamilton，DirectX 用 Shuster；ij=k vs ij=−k）——读者拿外部代码对不上号的首要原因。
   - 用 A3 的数值稳定 pitch 公式核对项目 `qToEuler`：pitch = 2·atan2(√(1+2d), √(1−2d)) − π/2（d = q.w·q.y − q.x·q.z）。
   - 可选：交叉积加速式 v′ = v + 2w(r×v) + 2r×(r×v)（快约 30%）写进性能小节。

### P2 · 系统性功能增强

7. **闭环控制演示**（待办落地，B9/B10）：两层结构——外环角度 P（sqrt 整形，ArduPilot 口径）→ 内环角速率 PID（Gibiansky τ=I·u + 4×4 电机混控矩阵），控制频率 100 Hz 与项目 500 Hz 解算分层；调参口诀（P 加 50% 至振荡、回退 40%、I=P）可脚本化成「振荡→回退」演示。
8. **IMU 误差模型升级**（待办落地，B8/D10/D5/D6/D7）：
   - 误差三级演化「白噪声→随机游走→零偏平方增长」+ Allan 方差三系数 N/K/B（σ(τ) 曲线 → N=σ(1)、K=σ(√3)、B≈0.664σ(min)）映射到 Q 与零偏随机游走；Woodman 的 1 秒误差数字作量化开场。
   - 模拟 IMU 面板加「器件预设」下拉：MPU-9250 / ICM-42688-P / BNO055 / 自定义，一键写入真实规格（陀螺噪声 0.01/0.0028/0.014 dps/√Hz；加计 300/70/175 μg/√Hz；量程/零偏容差等，见 §5 对照表）。
9. **测量拒绝/恢复机制教学**（C3）：Mahony/Madgwick 补 Fusion 式机制——加速度拒绝 10°、5 s 窗 90% 占比进恢复、磁拒绝/恢复同构、角速率超量程 98% 重启；与 ES-EKF 40° 新息门控对比成「观测可信度管理」专门一节（10° vs 40° 门控幅度差异值得讨论）。项目模拟器已有振动/线加速度/磁干扰源，正好驱动。
10. **磁力计标定交互**（C9/D11/D12）：「校准舞蹈」——拖拽机体六面旋转、点云逐步收圆、绿色覆盖度进度条；MotionCal 三组输出（硬铁/软铁/场强）与 AN4246 的 10 参数模型挂钩；加速度计 6 面校准同理；排障决策树写法做工程实践范本。
11. **Slerp 增强**（A2/A5）：参考球等间隔采样可用递推 pₖ₊₁ = c·pₖ − pₖ₋₁（c=2·dot，O(1)）；文档表述补「q₁(q₁⁻¹q₂)ᵘ 相对旋转」形式与「导数=半角速度」（与 q̇=½q⊗ω 同源）。
12. **三个低成本可视化演示**：①「两次反射=旋转」分步按钮（A7，v∥/v⊥ 着色分解）；② 立体投影「抬升-变换-投影」三段式镜头（A12）；③ 姿态视图叠加等效旋转轴箭头开关（A10）。

### P3 · 长线/可选

13. **文档页叙事重构**（D1/D2/D3/D10）：每章开头量化钩子 → 先失败后补救的 BUT/THEREFORE 结构 → 末尾全参数沙盒模式；每个 Canvas 演示配「示例状态一键还原」锚点。
14. **片上融合对照小节**（D7）：BNO055 的 7 种融合模式 vs 项目 5 算法——「传感器自带解算」的黑盒/可控性/成本取舍。
15. **VectorNav 口径补齐**（D9）：坐标系约定前置成节；「比力 ≠ 加速度（含重力项）」写进加速度计章节（线加速度扰动的理论根）。
16. **ES-EKF 深化**（B2/B3/C5）：文档标注 Φ≈I+FΔt 的 O(Δt²) 截断（Solà 附录给指数/RK4 精化）；注入后协方差重置修正（G·P·Gᵀ）在大角修正时非零项；40° 固定门控可标注为 χ² 马氏距离门控的工程简化；Joseph 形式数值稳定；状态扩展路线图（线加速度状态 → 陀螺比例因子 → 磁场状态 → 24 状态，C5/C6）。
17. **新误差滑块**（D6/D8）：交叉轴敏感度 ±2%、加计非线性 ±0.5%、磁量化 0.6 μT/LSB、加计倾角灵敏度随角度变化（17.45→0.15 mg/°）。
18. **Squad/多关键帧插值扩展**（A6）；陀螺零偏估计两条路线对比（Fusion 外置静止检测器 vs EKF 内联合估计，C3/C6）写进选型表。

### 模拟 IMU 参数 ↔ 真实器件规格对照表（器件预设下拉的数据源）

| 模拟参数 | MPU-9250 | ICM-42688-P | BNO055 | 来源 |
|---|---|---|---|---|
| 陀螺量程 (dps) | ±250/500/1000/2000 | ±15.625–2000（8 档） | ±125–2000 | D6/D5/D7 |
| 陀螺噪声密度 (dps/√Hz) | 0.01 | 0.0028 | 0.014 | 同上 |
| 陀螺初始零偏容差 | ±5 °/s | — | 自动校准 | D6 |
| 加计噪声密度 (μg/√Hz) | 300–400 | 70 | 175 | D6/D5/D7 |
| 加计零偏初始容差 | X/Y ±60 mg、Z ±80 mg | — | — | D6 |
| 磁力计分辨率/量程 | 0.6 μT/LSB、±4800 μT | — | 130–2500 μT | D6/D7 |
| 交叉轴敏感度 | 陀螺 ±0.2%、加计 ±2% | — | — | D6 |
| 片上融合 | — | APEX 计步/倾斜检测 | 7 种融合模式直出四元数 | D5/D7 |

---

## 7. 资源速查索引

### A 线 · 数学教学与可视化
| 编号 | 资源 | 一句话 |
|---|---|---|
| A1 | Wikipedia: Quaternions and spatial rotation | 双倍覆盖证明/超球面论述/约定对照/性能表 |
| A2 | Wikipedia: Slerp | slerp 公式/短路径/递推加速 |
| A3 | Wikipedia: Conversion between quaternions and Euler angles | 双向转换公式表/稳定 pitch 公式 |
| A4 | Allen Chou: Deriving the Slerp Formula | 纯向量几何 10 步推导 |
| A5 | Shoemake SIGGRAPH'85 | slerp 开山论文/S³ 拓扑 |
| A6 | Dam et al. DIKU 报告 103 页 | Slerp/Squad 完整证明 |
| A7 | Marc ten Bosch: Interactive Rotors | 两次反射=旋转交互长文 |
| A8 | Krasjet《四元数与三维旋转》 | 中文标准入门/万向节锁 Bonus |
| A9 | Matthew Brett: Gimbal lock | 矩阵代数算给你看/NumPy 实验 |
| A10 | Quaternions Online | 三向转换器/旋转轴显示 |
| A11 | Numberphile: Fantastic Quaternions | 大众科普视频 |
| A12 | Möbius Transformations Revealed | 立体投影镜头语言范本 |

### B 线 · 算法论文与深度教程
| 编号 | 资源 | 一句话 |
|---|---|---|
| B1 | Madgwick 2011 内部报告 | 梯度下降滤波原始文献/β 含义/运算量 |
| B2 | Joan Solà ES-EKF (arXiv 1711.02508) | ESKF 权威推导/F/H 雅可比 |
| B3 | Markley MEKF (NASA) | 乘性 vs 加性 EKF |
| B4 | ahrs.readthedocs Mahony 复述 | Mahony 2008 公式级复述/k₁k₂ 权重 |
| B5 | Welch & Bishop 卡尔曼入门 | 五公式/R 实测 Q 注入 |
| B6 | NXP AN4248 | 倾斜补偿罗盘标准公式 |
| B7 | NXP AN4246 | 硬铁/软铁 10 参数标定 |
| B8 | arXiv 1608.07053 | Allan 方差 N/K/B 系数 |
| B9 | Gibiansky 四轴动力学 | 最小闭环教程/混控矩阵 |
| B10 | ArduPilot 姿态控制文档 | 串级架构/调参口诀 |
| B11 | CSDN MPU6050 Mahony | 中文入门/Kp=1.5 Ki=0.005 |
| B12 | DR_CAN 卡尔曼系列 | 中文最佳卡尔曼视频 |
| B13 | DCM 漂移修正（替代源） | 重正交化/P-I 漂移修正 |

### C 线 · 开源实现与官方文档
| 编号 | 资源 | 一句话 |
|---|---|---|
| C1 | x-io 官方主页 | Madgwick 原始发布页 |
| C2 | MadgwickAHRS.c 源码 | 默认 β=0.1/磁全零降级 |
| C3 | xioTechnologies/Fusion | 增益调度/拒绝恢复机制/参数表 |
| C4 | PX4 EKF2 文档 | 24 状态/磁融合模式分级 |
| C5 | ArduPilot EKF2 文档 | 24 状态分组/误差旋转矢量 |
| C6 | MathWorks imufilter | 9 元误差状态/默认噪声矩阵 |
| C7 | three.js Quaternion 文档 | normalize/(x,y,z,w)/premultiply 语义 |
| C8 | three.js orientation 示例 | equals+rotateTowards 官方写法 |
| C9 | MotionCal（Adafruit 教程） | 标定工作流/覆盖度反馈 |
| C10 | Adafruit_AHRS | 统一接口/twoKp 约定 |

### D 线 · 教学设计与传感器实践
| 编号 | 资源 | 一句话 |
|---|---|---|
| D1 | ciechanow.ski/tesseract | 4D 几何交互/双面板对照 |
| D2 | ciechanow.ski/gps | 先失败后补救叙事/误差画壳 |
| D3 | Nicky Case 方法论 | 钩子/抽象阶梯/沙盒结尾 |
| D4 | explorabl.es | 可探索解释社区索引 |
| D5 | ICM-42688-P 规格 | 现役 6 轴 IMU 规格 |
| D6 | MPU-9250 规格书 | 教学 IMU 参数默认值出处 |
| D7 | BNO055 数据手册 | 片上融合对照组 |
| D8 | ST AN4509 | 倾角测量灵敏度表/三轴 atan2 |
| D9 | VectorNav 入门教程 | 坐标系前置/比力概念 |
| D10 | Woodman UCAM-CL-TR-696 | 1 秒误差量化/误差演化链 |
| D11 | ArduPilot 加速度计校准 | 6 面校准话术 |
| D12 | ArduPilot 罗盘校准 | 校准舞蹈/覆盖度进度条/排障树 |
