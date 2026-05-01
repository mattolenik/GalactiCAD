//
// farm.cpp
//
// Object Farm. The 2D entity represent data on the same plane. 
//
// Tien-Tsin Wong 1996
//
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include "asc.h"
#include "datatype.h"
#include "dikelign.h"
#include "strip.h"
#include "padi.h"
#include "slab.h"
#include "farm.h"



///////////////////////////// Class Farm //////////////////////////////
// Input Parameters:
// 1) data1     Pointer to 1D(physically) memory array which holds
//              the logical 3D data grid.
// 2) xis       Tell you what internal "X" is, permitted values are
//              DIMX, DIMY and DIMZ
// 3) yis       Tell you what internal "Y" is.
// 4) fixdim    The constant value of the fixed dimension
void Farm::Init(CHAR xis, CHAR yis, int fixdimval,
                CHAR *xocc, CHAR *yocc, SIMPLEDT *xver, SIMPLEDT *yver)
{
#ifdef SECURITY
  if (data1==NULL || xis<0 || xis>2 || yis<0 || yis>2 || fixdimval<0 || fixdimval>N || xis==yis)
  {
    ERRMSG("[Farm::Init]: input value invalid\n");
    return;
  }
#endif
  int i, offx, multx, offy, multy, posx, posy;
  CHAR nonempty;
  padilist=NULL;
  FixDimVal = fixdimval;
  EDimIs = 0;
  EDimIs = 0x03&(~(xis|yis));
  EDimIs = (EDimIs<<2)|(yis&0x03);
  EDimIs = (EDimIs<<2)|(xis&0x03);
  if (xis==XDIM && yis==YDIM) // xyfarm
  {
    multx = 1;    offx = FixDimVal*(N+1);
    multy = 1;    offy = FixDimVal*(N+1);
  }
  else if (xis==XDIM && yis==ZDIM) // xzfarm
  {
    multx = N+1;  offx = FixDimVal;
    multy = 1;    offy = FixDimVal*(N+1);
  }
  else if (xis==YDIM && yis==ZDIM) // yzfarm
  {
    multx = N+1;  offx = FixDimVal;
    multy = N+1;  offy = FixDimVal;
  }
  else
    ERREXIT("[Farm::init]: I don't know how to init\n");
  nonempty = 0;
  for (i=0 ; i<N+1 ; i++)
  {
    posx = (i*multx+offx)*SIZE;
    posy = (i*multy+offy)*SIZE;
    xlign[i].Init(&(xocc[posx]), &(xver[posx]));
    ylign[i].Init(&(yocc[posy]), &(yver[posy]));
    nonempty |= (xocc[posx+1]|yocc[posy+1]);
  }
  if (!nonempty)
    SetEmpty();
  // xstrip will be inited in the subroutine ProducePadi()
}


#ifndef PADISEARCH
void Farm::TagXStrip(Padi *padi)
{
#ifdef SECURITY
  if (padi==NULL)
  {
    ERRMSG("[Farm::TagXStrip]: invalid input valie\n");
    return;
  }
#endif
  int j;
  for (j=Start(padi->dike[LEFT]) ; j<End(padi->dike[LEFT]) ; j++)
    xstrip[j].usedby[padi->dike[BOTTOM]] = padi;
//  ShowTagMap(xstrip);
}


void Farm::UntagXStrip(Padi *padi)
{
#ifdef SECURITY
  if (padi==NULL)
  {
    ERRMSG("[Farm::UntagXStrip]: invalid input value\n");
    return;
  }
#endif
  int j;
  for (j=Start(padi->dike[LEFT]) ; j<End(padi->dike[LEFT]) ; j++)
    if (xstrip[j].usedby[padi->dike[BOTTOM]] == padi)
      xstrip[j].usedby[padi->dike[BOTTOM]] = NULL;
    else
    {
      printf ("[Farm::UnTagXStrip]: possible some bug in tagging the data UsedBy\n");
      printf ("padi %d x %d want to untag,\n", padi->dike[BOTTOM], padi->dike[LEFT]);
      if (xstrip[j].usedby[padi->dike[BOTTOM]]!=NULL)
        printf ("[Farm::UnTagXStrip]: strip %d, dike %d, occupied by padi %d x %d\n", j, padi->dike[BOTTOM],
                  xstrip[j].usedby[padi->dike[BOTTOM]]->dike[BOTTOM],
                  xstrip[j].usedby[padi->dike[BOTTOM]]->dike[LEFT]);
      else
        printf ("[Farm::UnTagXStrip]: strip %d, dike %d, occupied by no padi\n",  j, padi->dike[BOTTOM]);
    }
//  ShowTagMap(xstrip);
}
#endif



DoublyList *Farm::ProducePadi(Block *block, CHAR constrain)
{
  int j, i, jj, maxJ, k, competecnt;
  int ydike[N], ydikecnt, holdercnt;
  Padi *currpadi, *holder[N*N];
  CHAR padisuccess;
#if NLEVEL>0
  Padi *competitor[N*NLEVEL];
#else
  Padi *competitor[1];  // at least has one element
#endif

  // Init xstrip
  for (i=0 ; i<N ; i++)
    xstrip[i].Init(&(xlign[i]), &(xlign[i+1]));

  if (padilist!=NULL)
  {
    delete padilist;
    padilist = NULL;
  }
  if ((padilist=new DoublyList)==NULL)
    ERREXIT ("[Farm::ProducePadi]: no memory for padilist\n");
  for (j=0 ; j<N ; j++) // from bottom to top xstrip
    for (i=xstrip[j].simple[1] ; i>0 ; i=xstrip[j].NextSimple(i))
    {
      jj=j+1;  // Search for max J
      if (constrain&PP_PADICONSTR)
        while (jj<N && xstrip[jj].simple[i]==i
               && Length(ylign[Start(i)].simple[j+N])>jj-j)
          jj++;  // additional constrain due to produced padi
      else if (constrain&PP_HRICECONSTR)
        while (jj<N && xstrip[jj].simple[i]==i
               && N-ylign[Start(i)].simple[j]>jj-j)
          jj++;  // additional constrain due to produced highrices
      else
        while (jj<N && xstrip[jj].simple[i]==i)
          jj++;
      maxJ = jj-1;
      // Comment: Actually, the padi can grow downwards

      // Break this temporary padi into smaller padi along y, due to
      // binary restriction.
      ydikecnt=0;
      MinDikeSet(j, maxJ, ydike, ydikecnt);
      BreakDikeSet(ydike, ydikecnt, ylign, i);

      // Strategy used when there is overlapped padi:
      // For each overlapped padi,
      // 1) If current padi is enclosed by existing padi, throw current padi away
      // 2) If current padi enclosed by any existing padi, throw that padi away
      // 3) If current padi only overlap with existing padi, clip current padi
      //    by that padi.
      for (jj=0 ; jj<ydikecnt ; jj++) // for each candidate ydike
      {
        holdercnt = 0;
        if ((currpadi = new Padi)==NULL)
          ERREXIT ("[Farm::ProducePadi]: no memory for currpadi\n");
        currpadi->Init(i, ydike[jj], this, block);

        do // for each padi which is broken up by existing padi
        {
          if (holdercnt>0)  // consider clipped padi
          {
            holdercnt--;   // decrement counter
            currpadi = holder[holdercnt]; // pick one element from array
            holder[holdercnt] = NULL;
          }

          // Check whether it is already occupied. And find out competitors.
#ifdef PADISEARCH
          // Using straighforward linear search all existing padi
          Padi *tmppadi;
          competecnt=0;
          for (tmppadi=padilist->First() ; tmppadi!=NULL ; tmppadi=padilist->Next())
            if (tmppadi->OverlapQ(currpadi))
              competitor[competecnt++] = tmppadi;
#else
          // This method of searching competitor may not be very efficient
          for (k=Start(currpadi->dike[LEFT]), competecnt=0 ; k<End(currpadi->dike[LEFT]) ; k++)
            xstrip[k].UsedBy(currpadi->dike[BOTTOM],competitor,competecnt);
#endif
          padisuccess = TRUE;
          for (k=0 ; k<competecnt ; k++)
            // Check whether currpadi is enclosed by any competitor
            if (currpadi->EnclosedByQ(competitor[k]))
            { // no need to continue, simply delete current padi
#ifdef DEBUG
              printf ("remove current padi %d x %d\n", currpadi->dike[BOTTOM], currpadi->dike[LEFT]);
#endif
              delete currpadi;
              currpadi = NULL;
              padisuccess = FALSE;
              break;
            }
            // If currpadi enclose competitor padi, just throw competitor away
            else if (competitor[k]->EnclosedByQ(currpadi))
            {
#ifdef DEBUG
              printf ("remove competitor padi %d x %d\n", competitor[k]->dike[BOTTOM], competitor[k]->dike[LEFT]);
#endif
              UntagXStrip(competitor[k]);
              padilist->Remove(competitor[k]);
              delete competitor[k];
              competitor[k] = NULL;
            }
            else // only partial overlaid, break the current padi
            {
#ifdef DEBUG
              printf ("before: break current padi %d x %d\n", currpadi->dike[BOTTOM], currpadi->dike[LEFT]);
              printf ("clipped by padi %d x %d\n", competitor[k]->dike[BOTTOM], competitor[k]->dike[LEFT]);
#endif
              currpadi->ClipBy(competitor[k], holder, holdercnt, this, block);
              delete currpadi;
              currpadi = NULL;
              padisuccess = FALSE;
#ifdef DEBUG
              printf ("after: break current padi %d x %d\n", currpadi->dike[BOTTOM], currpadi->dike[LEFT]);
#endif
              break; // no need to continue, since the clipped portion have to go through the whole test
            }

          if (padisuccess)
          {
            TagXStrip(currpadi); // Tag those occupied region
            padilist->Append(currpadi);  // Insert the current padi into the doubly linked list
#ifdef DEBUG
            printf ("current padi born %d x %d\n", currpadi->dike[BOTTOM], currpadi->dike[LEFT]);
#endif
          }
        }while (holdercnt>0);
      }
  }
  return padilist;
}


// 2nd time init (reuse) simple array in the class Lign
// You should be careful to call this subroutine, since this calling will
// destroy the data stored in simple[] array previously.
// This function make use of the info store in the input Strip.
void Farm::InitSimpleByPadi()
{
#ifdef SECURITY
  if (padilist==NULL)
  {
    ERRMSG("[InitSimpleByPadi]: No padi for initialization\n");
    return;
  }
#endif
  int i, j, ldikestart, bdikestart, ldikeend, bdikeend;
  Padi *currpadi;

  // clear the value in the simple array of xlign and ylign
  for (i=0 ; i<N+1 ; i++)
  {
    memcpy(ylign[i].simple, Lign::nullsimple, Lign::simplesize);
    memcpy(xlign[i].simple, Lign::nullsimple, Lign::simplesize);
  }

  // Init only the bottom level of the simple[] arrays using info in padilist
  for (currpadi=padilist->First() ; currpadi!=NULL ; currpadi=padilist->Next())
  { // record only the left bottom corner in the simple array
    ldikestart = Start(currpadi->dike[LEFT]);
    ldikeend   = End(currpadi->dike[LEFT]);
    bdikestart = Start(currpadi->dike[BOTTOM]);
    bdikeend   = End(currpadi->dike[BOTTOM]);
    for (i=ldikestart ; i<ldikeend ; i++)
      xlign[i].simple[bdikestart+N] = currpadi->dike[BOTTOM];
    for (i=bdikestart ; i<bdikeend ; i++)
      ylign[i].simple[ldikestart+N] = currpadi->dike[LEFT];
  }

  // for each xlign and ylign
  // propagate the available info upward
  for (i=0 ; i<N ; i++)
  {
    for (j=N-1 ; j>0 ; j--)
    {
      xlign[i].simple[j] = xlign[i].simple[j<<1];
      ylign[i].simple[j] = ylign[i].simple[j<<1];
    }
    xlign[i].simple[0] = -1; // undefined
    ylign[i].simple[0] = -1;
  }

  // for each xlign and ylign if the value == -1,
  // propagate info downward
  for (i=0 ; i<N ; i++)
  {
    for (j=1 ; j<SIZE ; j++)
    {
      if (xlign[i].simple[j] == -1) // no value filled
        if (0x01&j) // odd numbered dike
          xlign[i].simple[j] = j;
        else // even numbered dike, inherent from parent
          xlign[i].simple[j] = xlign[i].simple[j>>1];
      if (ylign[i].simple[j] == -1) // no value filled
        if (0x01&j) // odd numbered dike
          ylign[i].simple[j] = j;
        else // even numbered dike, inherent from parent
          ylign[i].simple[j] = ylign[i].simple[j>>1];
    }
  }

  // copy the simple info to xlign[N] and ylign[N]
  for (i=0 ; i<SIZE ; i++)
  {
    xlign[N].simple[i] = xlign[N-1].simple[i];
    ylign[N].simple[i] = ylign[N-1].simple[i];
  }

#ifdef DEBUG
  for (i=0 ; i<N+1 ; i++)
  {
    printf ("xlign[%d]:\n",i);
    DISPLAYTREE(xlign[i].simple);
    printf ("ylign[%d]:\n",i);
    DISPLAYTREE(ylign[i].simple);
  }
#endif
}


void Farm::InitSimpleBySlab(Slab *below, Slab *above)
{
#ifdef SECURITY
  if (below==NULL || above==NULL)
  {
    ERRMSG("[InitSimpleBySlab]: invalid input value\n");
    return;
  }
#endif
  int i, j;
  for (j=0 ; j<N+1 ; j++)
    for (i=0 ; i<SIZE ; i++)
    {
      xlign[j].simple[i] = MAX(below->xlign[j].simple[i], above->xlign[j].simple[i]);
      ylign[j].simple[i] = MAX(below->ylign[j].simple[i], above->ylign[j].simple[i]);
    }
}


