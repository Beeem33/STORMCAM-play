/**
 * STORMCAM procedural prop library.
 * Conventions: metres, Y up, origin at ground level at the centre of the footprint, building fronts face +Z.
 * Every texture and material is cached at module level (see textures.ts memo / materials.ts std),
 * so many buildings share a handful of GPU textures and materials.
 */
export type { Collider, PropBuild, InstancedAsset, TreeKind, RoadSignKind } from './types';
export { buildFarmhouse } from './farmhouse';
export { buildBarn, buildGrainBin, buildSilo, buildMachineShed } from './farm';
export { buildGasStation } from './gasStation';
export { buildRoadSign, buildMailbox } from './roadside';
export { telephonePoleAsset, fencePostAsset, hayBaleAsset } from './instanced';
export { treeAssets } from './trees';
export { buildWindmill, buildPumpjack, posePumpjack, buildCenterPivot, buildStockTank, buildHayStack } from './decor';
export { buildGrainElevator, buildWaterTower, buildChurch, buildBillboard, buildBarricade } from './town';
export { buildAbandonedTruck } from './truck';
export { triCount } from './util';
