//
// block.h
//
// Header of object block. The top-level manipulation unit of asc.
//
// Tien-Tsin Wong 1996
//
#ifndef __BLOCK_H
#define __BLOCK_H

#include "datatype.h"
#include "slab.h"
#include "farm.h"
#include "doublist.h"

// Similar flag as PADISEARCH
#define HIGHRICESEARCH

#define RENDERMAN 0
#define TPOLY     1
#define TRIBINARY 2


class Block
{
  public:
    VOXELDT *BlockData;
    int DataDimX, DataDimY, DataDimZ; // real size of the data
    int OffX, OffY, OffZ;
    DoublyList *highricelist;
    Farm xyfarm[N+1], xzfarm[N+1], yzfarm[N+1];
    Slab slab[N];
    SIMPLEDT xver[(N+1)*(N+1)*SIZE],   // A "global" way to store ver[] and occ[]
             yver[(N+1)*(N+1)*SIZE],   // for all ligns. If ver[] and occ[] belongs to
             zver[(N+1)*(N+1)*SIZE];   // lign, then each ver[] will be duplicated twice.
    CHAR xocc[(N+1)*(N+1)*SIZE],
         yocc[(N+1)*(N+1)*SIZE],
         zocc[(N+1)*(N+1)*SIZE];

  private:
    // 4 small info are packed in one byte:
    // 1) Block is empty bit (no isosurface crossing)  
    // 2) what X direction is  3) what Y direction is  4) what Z is 
    UCHAR EXYZis; // bit      7       6    5 4   3 2   1 0
                  // means:   empty        Zis   Yis   Xis
  private:
    DoublyList *ProduceHighRice(Farm *farm);
    void InitSimpleByHighRice();
    void CalVertex(float *coord, int *cube, CHAR side, double &ratio);
    void CalFastGradient(float *coord, int *cube); // not exact gradient for fast processing
    void Initocc(Data &data, CHAR *occ);
    void Initver(CHAR *occ, SIMPLEDT *ver);
    CHAR XisQ(){return (EXYZis & 0x03);};
    CHAR YisQ(){return (EXYZis>>2) & 0x03;};
    CHAR ZisQ(){return (EXYZis>>4) & 0x03;};
    void SetXis(CHAR xis){EXYZis = (EXYZis&0xfc)|(xis&0x03);};
    void SetYis(CHAR yis){EXYZis = (EXYZis&0xf3)|((yis&0x03)<<2);};
    void SetZis(CHAR zis){EXYZis = (EXYZis&0xcf)|((zis&0x03)<<4);};

  public:
    Block(){highricelist=NULL;};
    ~Block(){};
    void Init(VOXELDT *data, CHAR xis, CHAR yis, CHAR zis,
              int offx, int offy, int offz,
              int datadimx, int datadimy, int datadimz);
    void Cleanup();
    void BuildHighRice();
    void GenerateTriangle(CHAR format, CHAR withnormal, FILE *file);
    void OutTriangle(HighRice *hrice, int *path, int *pathcnt, int pathno, CHAR format, CHAR withnormal, FILE *file);
    void OutRenderMan(float *v, float *n, int *idx, CHAR withnormal, FILE *file);
    void OutTPoly(float *v, float *n, int *idx, CHAR withnormal, FILE *file);
    void OutTriBinary(float *v, float *n, int *idx, CHAR withnormal, FILE *file);
    void CommunicateSimple(Block *bottom, Block *top, Block *nearxz, Block *farxz, Block *nearyz, Block *faryz);
    CHAR EmptyQ(){return (EXYZis&0x80)!=0;};
    void UnsetEmpty(){EXYZis &= 0x7f;};
    void SetEmpty()  {EXYZis |= 0x80;};
#ifdef HIGHRICESEARCH
    void UntagSlab(HighRice *){};
    void TagSlab(HighRice *){};
#else
// not yet implemented
#endif
};

#endif

