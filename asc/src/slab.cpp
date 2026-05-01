//
// slab.cpp
//
// Object Slab. The volume between 2 consecutive parallel farms.
// Bookkeep the occupant.
//
// Tien-Tsin Wong 1996
//
#include <stdlib.h>
#include <stdio.h>
#include "asc.h"
#include "misc.h"
#include "common.h"
#include "dikelign.h"
#include "farm.h"
#include "slab.h"

/////////////////////////////// Class Slab ////////////////////////////
void Slab::Init(Farm *farmk, Farm *farmkplus1)
{
#ifdef SECURITY
  if (farmk==NULL || farmkplus1==NULL)
  {
    ERRMSG("[Slab::Init]: invalid input value\n");
    return;
  }
#endif
  int i, j;
  empty = farmk->EmptyQ() && farmkplus1->EmptyQ();
  for (i=0 ; i<N ; i++)
  {
    for (j=0 ; j<SIZE ; j++)
    {
      xlign[i].simple[j] = MAX(farmk->xlign[i].simple[j],
                               farmkplus1->xlign[i].simple[j]);
      ylign[i].simple[j] = MAX(farmk->ylign[i].simple[j],
                               farmkplus1->ylign[i].simple[j]);
    }
#ifdef DEBUG
    printf ("xlign[%d]:\n", i);
    DISPLAYTREE(xlign[i].simple);
    printf ("ylign[%d]:\n", i);
    DISPLAYTREE(ylign[i].simple);
#endif
  }
}


// Get the first vacant padi in the slab
// INPUT PARAMETER:
// 1) xydike    a pointer to an 2 elements array to hold the x y dike
//
// RETURN VALUES:
// When success, return TRUE and xydike filled with the x y dikes
// When fail, return FALSE
int Slab::FirstPadi(int *xydike)
{
#ifdef SECURITY
  if (xydike==NULL)
  {
    ERRMSG("[Slab::FirstPadi]: invalid input value\n");
    return NULL;
  }
#endif
  int i, j, off, totalbyte=((N*N)>>3)+1;
  // clear the bitmap
  for (i=0 ; i<totalbyte ; i++)
    bitmap[i] = 0x0;

  // search through the bitmap for vacant padi
  for (py=0 ; py<N ; py++) // for each horizontal strip
    for (xdike=xlign[py].simple[1] ; xdike>0 ; xdike=xlign[py].NextSimple(xdike))  // for each simple x dike
    {
      off = py*N + Start(xdike);
      if (!(bitmap[off>>3]&((UCHAR)(0x80>>(off&0x07))))) // vacant padi
      {
        xydike[0] = xdike;
        xydike[1] = ylign[Start(xdike)].simple[py+N];
        int endpy = py + Length(xydike[1]);
        // mark this padi as occupied
        for (j=py ; j<endpy ; j++, off+=N)  // mark ONLY the left side of the padi
          bitmap[off>>3] |= (UCHAR)(0x80>>(off&0x07));
        return TRUE;
      }
    }
  return FALSE;
}


// Get next vacant padi in the slab
// INPUT and OUTPUT are same as FirstPadi()
int Slab::NextPadi(int *xydike)
{
#ifdef SECURITY
  if(xydike==NULL)
  {
    ERRMSG("[Slab::NextPadi]: invalid input value\n");
    return NULL;
  }
#endif
  int j, off;
  // continue the search for vacant padi
  for ( ; py<N ; py++) // for each horizontal strip
  {
    if (xdike>0)
      xdike = xlign[py].NextSimple(xdike);
    else
      xdike = xlign[py].simple[1];
    for ( ; xdike>0 ; xdike=xlign[py].NextSimple(xdike))  // for each simple x dike
    {
      off = py*N + Start(xdike);
      if (!(bitmap[off>>3]&((UCHAR)(0x80>>(off&0x07))))) // vacant padi
      {
        xydike[0] = xdike;
        xydike[1] = ylign[Start(xdike)].simple[py+N];
        int endpy = py + Length(xydike[1]);
        // mark this padi as occupied
        for (j=py ; j<endpy ; j++, off+=N)  // mark ONLY the left side of the padi
          bitmap[off>>3] |= (UCHAR)(0x80>>(off&0x07));
        return TRUE;
      }
    }
  }
  return FALSE;
}

