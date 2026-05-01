//
// initdata.h
//
// This header file defines functions to init the voxel data grid.
// Although it is completely in C, please compile it using C++ compiler.
//

#ifndef __INITDATA_H
#define __INITDATA_H

#include "datatype.h"
#include "vortex.h"

#define ORDER_XYZ 	0
#define ORDER_XZY	1
#define ORDER_YXZ	2
#define ORDER_YZX	3
#define ORDER_ZXY	4
#define ORDER_ZYX	5

void InitDataMetaball(VOXELDT *data, int width, int depth, int height);
void InitKnotSurface(VOXELDT *data, int col, int row, int slc, int sqr);
void InitDataHeightField(VOXELDT *&data, long &width, long &depth, long &height, DCHAR *filename);
void ReadRawByte(VOXELDT *data, int w, int d, int h, DCHAR *filename);
void ReadRawByte16(VOXELDT *data, int w, int d, int h, DCHAR *filename);
void ReadPGM(VOXELDT *data, int w, int d, int h, DCHAR *prefix, int start);
void ScaleVolume(VOXELDT *data, int w, int d, int h,
                 VOXELDT *&newdata, int nw, int nd, int nh);
void PermuteVolume(VOXELDT *&data, int &w, int &d, int &h, 
                   double &ws, double &ds, double &hs, int neworder);

// Functions to read MIRA files
int readMiraFile(volume *v, DCHAR *filename, short textureblock, float actualzgap);

#endif

