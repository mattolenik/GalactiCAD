//
// farm.h
//
// Header of farm.cc
// 
// Tien-Tsin Wong 1996
//
#ifndef __FARM_H
#define __FARM_H

#include "datatype.h"
#include "doublist.h"
#include "dikelign.h"
#include "strip.h"

// Another performance issue is about search all overlapping padi
// during padi generation. You may think some tricky approach would
// be faster. I have previously used the UsedBy[] array to keep
// track all occupiant padi. But the procedure seems to run in
// O(n*n) time in the worst cases, where n is the number of dikes
// to visit. For each xstrip (n strips), you have to search
// the binary tree for competitors (worst case 2n dikes visited).
// On the other hand, if you search the existing padi one by one,
// the algorithm is almost n*n padi to visit. That is, seems no
// gain. I have not tested which one will perform better. One
// phenomenon is worth for consideration. The padi tends to be
// larger. If that is the case, I guess searching padi one by one
// will be better, since the overhead of bookkeeping approach is
// large. If on the other hand, padi is fine and small, bookkeeping
// approach may be good.
//#define PADISEARCH // If this flag on, the searching of competitors
                   // in ProducePadi will be a linear search
                   // through all existing padi. Otherwise, bookkeeping
                   // array UsedBy[] will be used for book keeping.

// In order to be more flexible, the "x" and "y" in the class farm may
// differ from the real x, y, z. Hence variable "Xis" and "Yis" are
// used to tell you what they are exactly.
// The following are some macros define what "Xis" and "Yis" are.
#define XDIM  0    // It is X
#define YDIM  1    // It is Y
#define ZDIM  2    // It is Z
#define PP_PADICONSTR  0x01  // impose padi constrain
#define PP_HRICECONSTR 0x02  // impose highrice constrain

class Farm
{
  private:
    SIMPLEDT FixDimVal;   // The value of the fixed dimension
    UCHAR EDimIs;   // bit   7       6   5 4     3 2  1 0
                    // mean  empty?      FixDim  Yis  Xis
    		    // tells you what "x" and "y" actually are.
                    // and the fixed dimension. Whether the farm has no isosurface crossing
  public:
    Lign xlign[N+1], ylign[N+1];
    Strip xstrip[N];
    DoublyList *padilist;  // hold the generated padis

  public:
    void CleanUp() {if (padilist) delete padilist; padilist=NULL;};
    Farm(){padilist=NULL;}; // init to invalid value
    ~Farm(){CleanUp();};
    void Init(CHAR xis, CHAR yis, int fixdimval,
	      CHAR *xocc, CHAR *yocc, SIMPLEDT *xver, SIMPLEDT *yver);
    CHAR EmptyQ()    {return (EDimIs&0x80)!=0;};
    void UnsetEmpty(){EDimIs = EDimIs&0x7f;};
    void SetEmpty()  {EDimIs = EDimIs|0x80;};
    int XisV()   {return EDimIs&0x03;};
    int YisV()   {return (EDimIs>>2)&0x03;};
    int FixDimV(){return (EDimIs>>4)&0x03;};
    int FixDimValV(){return FixDimVal;};
    void InitSimpleByPadi();
    void InitSimpleBySlab(Slab *below, Slab *above);
    DoublyList *ProducePadi(Block *block=NULL, CHAR constrain=0);
#ifdef PADISEARCH
    void TagXStrip(Padi *){};  // no effect
    void UntagXStrip(Padi *){};
#else
    void TagXStrip(Padi *padi);
    void UntagXStrip(Padi *padi);
#endif
};

#endif
