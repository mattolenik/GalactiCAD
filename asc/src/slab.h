//
// slab.h
//
// Header of slab.cc
//
// Tien-Tsin Wong 1996
//
#ifndef __SLAB_H
#define __SLAB_H

#include "misc.h"
#include "datatype.h"
#include "dikelign.h"

// enumeration of the index of the 4 subsquares.
#define SB_BL 0   // Bottom left
#define SB_BR 1   // Bottom right
#define SB_TL 2   // Top left
#define SB_TR 3   // Top right

class Slab
{
  private:
    int py, xdike;
    UCHAR bitmap[((N*N)>>3)+1];
    CHAR empty;   // the slab is empty, no isosurface crossing

  public:
    Lign xlign[N], ylign[N];

  public:
    int FirstPadi(int *xydike);
    int NextPadi(int *xydike);

  public:
    Slab(){};
    ~Slab(){};
    CHAR EmptyQ(){return empty;};
    void SetEmpty(){empty = TRUE;};
    void UnsetEmpty(){empty = FALSE;};
    void Init(Farm *farmk, Farm *farmkplus1);
};

#endif
