//
// data.h
//
// The data structure of the voxel grid. 
//
// Tien-Tsin Wong  1996
// 
#ifndef __DATA_H
#define __DATA_H

#include "datatype.h"

#define VARYX  0
#define VARYY  1
#define VARYZ  2
#define OUTBND 3
// index orientation: left->right bottom->top
// index starts from 0
class Data
{
  private:
    VOXELDT *content;      // pointer to the data array
    int width,  // along x axis
        depth,  // along y axis
        height; // along z axis
    int OffX, OffY, OffZ;
    int fixedx, fixedy, fixedz; // index of fixed x, index of fixed y
    int offset, multiplier; // a precomputed variables for fast addressing
    CHAR vary;  // 1st bit from the left = 1 means x is variable
                // 2nd bit from the left = 1 means y is variable
                // 3rd bit from the left = 1 means z is variable

  public:
    void ReInit(VOXELDT *info, int x, int y, int z, int offx,
                int offy, int offz, int datadimx, int datadimy,
                int datadimz);
    Data(VOXELDT *info, int x, int y, int z, int offx,
         int offy, int offz, int datadimx, int datadimy, int datadimz)
         {ReInit(info,x,y,z,offx,offy,offz,datadimx,datadimy,datadimz);};
    ~Data(){};
    VOXELDT Value(int i);
    CHAR operator[](int i);
};

#endif

