#ifndef __INDEX_H
#define __INDEX_H


#include "datatype.h"


class DataBlock
{
  public:
    // level_size, max and min are keys
    short level_size; // which level this cube belong and what is its size?
    // least significat 3 bits to store the block size
    // other bits store the z info.
    VOXELDT max,     // first key
	    min;     // second key
    // x, y and z (level in "level_size") fully specify the location of the
    // block
    UCHAR x, y;  // z info is embedded in level_size, use 1 byte only since no memory

  public:
    int XisQ(){return x;};
    int YisQ(){return y;};
    int ZisQ(){return level_size>>3;};
    int BlockSizeQ(){return level_size&0x07;};
};

KdTree *KdIndexBlock(VOXELDT *data, int x, int y, int z, DataBlock *&allocarr);
KdTree *ReadKdIndex(DCHAR *idxfile, int x, int y, int z, DataBlock *&allocarr);
void QueryKdTree(KdTree *kdtree, int level, int nlevel, VOXELDT threshold, long *result, int maxcnt, int &resultcnt);

#endif


