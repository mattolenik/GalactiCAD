//
// global.h
//
// Define some global accessible variables.
// All global variables are located in asc.cc
//
// Tien-Tsin Wong 1996
//
#ifndef __GLOBAL_H

#include "datatype.h"

extern VOXELDT *G_data1;
extern VOXELDT G_Threshold;
extern double G_CosAngleThresh; // cos angle threshold of the confirmation % gradient normal and triangle normal
extern double G_AngleThresh; // angle of derivation constrain in degree
extern float G_mindpvalue;
extern long G_Stat_TriangleCnt; // total no of triangles generated
extern long G_DataWidth;
extern long G_DataDepth;
extern long G_DataHeight;
extern float G_2_DataWidth;    // 2 / G_DataWidth
extern float G_WidthScale;    // scale factor of the voxel. 
extern float G_DepthScale;    // used only when calculating the world coordinate of vetex
extern float G_HeightScale;  
extern float G_WidthScale_2;  // G_WidthScale / 2
extern float G_DepthScale_2;  // G_DepthScale / 2
extern float G_HeightScale_2; // G_HeightScale / 2
extern long G_NonEmptyBlockCnt;   // Count the total no of empty block(without isosurface crossing)
// Some flag to switch on/off some mechanism
extern CHAR G_HandleAmbiguity;  // Handle the ambiguity of crossing edge of padi
extern CHAR G_HandleBeauty;     // Handle the confirmation of gradient normal and triangle normal
extern long G_HighriceCnt;
extern long G_EmptyHighriceCnt;

#endif

