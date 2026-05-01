//
// highrice.h
//
// Header of the 3D subdivided rectangular volume within 1 block.
//
// Tien-Tsin Wong 1996
//
#ifndef __HIGHRICE_H
#define __HIGHRICE_H

#include "datatype.h"
#include "padi.h"
#include "misc.h"
 
#define HR_BOTTOM    0
#define HR_TOP       1   // Index to offset[]
#define HR_NEARXZ    2
#define HR_FARXZ     3
#define HR_NEARYZ    4
#define HR_FARYZ     5


// Notice the notation change, from left to right, we call +ve X,
// From near to far, we call +ve Y. From bottom to top, we call +ve Z.
// although HighRice inherent from Padi, it only used the array dike[]
// EnclosedByQ(), OverlapQ() and ClipBy() functions.
class HighRice : public Padi
{
  private:
    int edgeno;      // no of unit edges on the surface of the highrice
                     // edgeno = 4 *(pq + qr + rp)   is no of edges of p x q x r highrice
    int offset[6];   // offset pointer to the 1st entry of each face of highrice
    int width, height, depth;
    CHAR empty;

  public:
    int bottom, top;  // identify the highrice with width dike (dike[1])
                      // and depth dike (dike[0]) and [bottom,top]
                      // bottom < top
  public:
    HighRice():Padi(){};
    ~HighRice(){};
    CHAR CheckEmpty(Farm *xyfarm);
    CHAR EmptyQ(){return empty;};
    void SetEmpty(){empty=TRUE;};
    void UnsetEmpty(){empty=FALSE;};
    void Init(int xdike, int ydike, int bottom, int top);
    int EnclosedByQ(HighRice *encloser);
    int OverlapQ(HighRice *highrice);
    void ClipBy(HighRice *clipper, HighRice **holder, int &cnt);
    void SetupEdgeTable(Farm *xyfarm, Farm *xzfarm, Farm *yzfarm, int *edge);
    void GeneratePath(int *path, int *pathcnt, int &pathno, int *edge);
    int MapToEdgeTable(CHAR face, Farm *farm, Padi *padi, CHAR side);
    void IndexToCoord(int idx, int *coord, CHAR &xyz);
};


void HighRiceStatistic(DoublyList *highricelist);
void Out3DHighRice(VOXELDT *data1, Farm *farm, DoublyList *highricelist,
                   int offx, int offy, int offz, int datadimx,
                   int datadimy, int datadimz);


#endif

